import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHANNEL, MODEL_CHANGED, modelSelectionSchema, rpcContract, type ModelSelection, type ModelSettings } from "./contract";
import { PredictionCoordinator, type Source } from "./lib/coordinator";
import { CACHE_MIGRATIONS, SqlitePredictionCache } from "./lib/cache";
import { buildConversation, generationPrompt, parsePrediction, sourceKey, PREDICTION_PROMPT, WORKER_INSTRUCTIONS, type RecordedEvent } from "./lib/prediction";

const WORKER_TITLE = "Composer prediction helper";
type PredictionPermissionMode = "auto" | "accept-edits";
type PredictionSource = Source & { execution: { projectId: string; environmentId: string | null; providerId: string; reasoningLevel: string; permissionMode: PredictionPermissionMode; serviceTier?: string } };
const MODEL_KEY = "prediction-model";
const PROMPT_KEY = sourceKey(PREDICTION_PROMPT, WORKER_INSTRUCTIONS);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Composer predictions", default: true, description: "Suggest a next message in an empty composer. Tab inserts it without sending." },
    contextCharacters: { type: "number", label: "Conversation character budget", default: 48000, experimental_schema: z.number().int().min(4000).max(120000) },
  });
  let config = await settings.get();
  const database = bb.storage.database();
  bb.storage.migrate(database, CACHE_MIGRATIONS);
  const cache = new SqlitePredictionCache(database);
  const storedModel = modelSelectionSchema.safeParse(await bb.storage.kv.get(MODEL_KEY));
  let modelSelection: ModelSelection | null = storedModel.success ? storedModel.data : null;
  let modelWrite = Promise.resolve();
  const interested = new Set<string>();
  const workers = new Set<string>();
  const rejectedWorkers = new Set<string>();
  // Helpers whose provider cannot approve automatically. An approval they raise
  // is shown to the user instead of failing the prediction.
  const promptedWorkers = new Set<string>();
  const approvalRequested = new Set<string>();
  const revealedWorkers = new Set<string>();
  const presentingApproval = new Map<string, Promise<void>>();
  const wakeups = new Map<string, () => void>();
  type Catalog = Awaited<ReturnType<typeof bb.sdk.providers.models>>;
  // `auto` stays unattended. Otherwise ask in the workspace mode. `full` never
  // asks, so it is not a stand-in for a provider that cannot approve automatically.
  function predictionPermissionMode(modes: readonly string[] | undefined): PredictionPermissionMode {
    if (modes?.includes("auto")) return "auto";
    if (modes?.includes("accept-edits")) return "accept-edits";
    throw new Error("This prediction provider cannot approve automatically or ask you for approval.");
  }
  function resolveModel(catalog: Catalog, preferred: ModelSelection): ModelSelection {
    const provider = catalog.providers.find(row => row.id === preferred.providerId);
    if (!provider) throw new Error(`Prediction model ${preferred.model} is unavailable for ${preferred.providerId} on this machine.`);
    predictionPermissionMode(provider.capabilities.permissionModes);
    const model = catalog.models.find(row => row.model === preferred.model || row.id === preferred.model);
    if (!model) throw new Error(`Prediction model ${preferred.model} is unavailable for ${preferred.providerId} on this machine.`);
    const efforts = model.supportedReasoningEfforts.map(row => row.reasoningEffort);
    const reasoningLevel = efforts.length === 0 || efforts.includes(preferred.reasoningLevel) ? preferred.reasoningLevel : model.defaultReasoningEffort;
    if (preferred.serviceTier && preferred.serviceTier !== "default" && !model.supportedServiceTiers?.some(tier => tier.id === preferred.serviceTier)) throw new Error(`This prediction model does not support the ${preferred.serviceTier} service tier.`);
    return modelSelectionSchema.parse({ providerId: preferred.providerId, model: model.model, reasoningLevel,
      ...(preferred.serviceTier && model.supportedServiceTiers?.length ? { serviceTier: preferred.serviceTier } : {}) });
  }
  async function readModelSettings(): Promise<ModelSettings> {
    if (modelSelection) return { selection: modelSelection, pickerDefault: modelSelection };
    try {
      const options = await bb.sdk.system.executionOptions();
      const model = options.models.find(row => row.isDefault) ?? options.models[0];
      const providerId = model?.routeProviderId ?? options.providers.find(row => row.available)?.id;
      const seed = model && providerId ? modelSelectionSchema.safeParse({ providerId, model: model.model, reasoningLevel: model.defaultReasoningEffort }) : null;
      // Fork: say WHY the picker has no default, instead of a silent "catalog unavailable".
      if (!seed?.success) bb.log.warn(`Model catalog without picker default: ${JSON.stringify({
        models: options.models.length, providers: options.providers.map(row => ({ id: row.id, available: row.available })),
        model: model ? { model: model.model, routeProviderId: model.routeProviderId, isDefault: model.isDefault, defaultReasoningEffort: model.defaultReasoningEffort } : null,
        providerId: providerId ?? null, issues: seed && !seed.success ? seed.error.issues : null })}`);
      return { selection: null, pickerDefault: seed?.success ? seed.data : null };
    } catch (error) {
      bb.log.warn(`Model catalog unavailable: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      return { selection: null, pickerDefault: null };
    }
  }
  function changeModel(next: ModelSelection | null): Promise<ModelSettings> {
    const result = modelWrite.then(async () => {
      const saved = next ? resolveModel(await bb.sdk.providers.models({ providerId: next.providerId }), next) : null;
      if (saved) await bb.storage.kv.set(MODEL_KEY, saved);
      else await bb.storage.kv.delete(MODEL_KEY);
      modelSelection = saved;
      clearPredictions();
      bb.realtime.publish(MODEL_CHANGED, {});
      return readModelSettings();
    });
    modelWrite = result.then(() => {}, () => {});
    return result;
  }
  function clearPredictions() {
    try { cache.clear(); }
    catch (error) { bb.log.warn(`Prediction cache unavailable: ${String(error)}`); }
    for (const threadId of interested) coordinator.clear(threadId);
  }

  async function source(threadId: string, signal: AbortSignal): Promise<PredictionSource | null> {
    if (!config.enabled) return null;
    const override = modelSelection;
    const thread = await bb.sdk.threads.get({ threadId, signal });
    if (thread.status !== "idle" || thread.visibility === "hidden" || thread.archivedAt || thread.deletedAt || thread.queuedMessageCount > 0 || thread.activeBackgroundAgentCount > 0) return null;
    const options = override ? null : await bb.sdk.threads.defaultExecutionOptions({ threadId, signal });
    if (!override && !options?.model) return null;
    const providerId = override?.providerId ?? thread.providerId;
    const wantedModel = override?.model ?? options!.model;
    const catalog = await bb.sdk.providers.models(thread.environmentId
      ? { providerId, environmentId: thread.environmentId, signal }
      : { providerId, projectId: thread.projectId, signal });
    const model = catalog.models.find(row => row.model === wantedModel || row.id === wantedModel);
    const efforts = model?.supportedReasoningEfforts.map(row => row.reasoningEffort) ?? [];
    const automaticEffort = ["low", "none", "medium"].find(effort => efforts.includes(effort)) ?? model?.defaultReasoningEffort ?? "low";
    const executionModel = resolveModel(catalog, override ?? modelSelectionSchema.parse({ providerId, model: wantedModel, reasoningLevel: automaticEffort }));
    const permissionMode = predictionPermissionMode(catalog.providers.find(row => row.id === executionModel.providerId)?.capabilities.permissionModes);
    const events: RecordedEvent[] = [];
    let beforeSeq: string | undefined;
    for (let page = 0; page < 4; page++) {
      const rows = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "100", types: ["client/turn/requested", "item/completed"], ...(beforeSeq ? { beforeSeq } : {}), signal });
      events.push(...rows);
      if (rows.length < 100) break;
      beforeSeq = String(rows[rows.length - 1].seq);
    }
    const conversation = buildConversation(events, config.contextCharacters);
    if (!conversation) return null;
    const identity = { version: 1, prompt: PROMPT_KEY, execution: executionModel, contextCharacters: config.contextCharacters,
      projectId: thread.projectId, environmentId: thread.environmentId, latestSeq: Math.max(...events.map(event => event.seq)) };
    return { key: sourceKey(JSON.stringify(identity), conversation), model: executionModel.model, conversation,
      execution: { projectId: thread.projectId, environmentId: thread.environmentId, providerId: executionModel.providerId, reasoningLevel: executionModel.reasoningLevel, permissionMode, ...(executionModel.serviceTier ? { serviceTier: executionModel.serviceTier } : {}) } };
  }
  const workerReleases = new Map<string, Promise<void>>();
  // Stop before archive. BB forwards an archive to the provider only once the
  // helper is idle; archiving a running helper leaves that provider chat open.
  // A failed archive stays tracked so reload and the next start can retry it.
  // Deleting the BB thread would drop the only link to that chat.
  function releaseWorker(threadId: string): Promise<void> {
    const current = workerReleases.get(threadId);
    if (current) return current;
    const release = (async () => {
      try { await bb.sdk.threads.stop({ threadId }); }
      catch (error) { bb.log.warn(`Prediction helper stop: ${String(error)}`); }
      // A helper opened for approval would otherwise stay in the sidebar after
      // its archive. Hiding can fail; the archive is still the cleanup that matters.
      if (revealedWorkers.has(threadId)) {
        try { await bb.sdk.threads.update({ threadId, visibility: "hidden" }); }
        catch (error) { bb.log.warn(`Prediction helper hide: ${String(error)}`); }
      }
      try {
        await bb.sdk.threads.archive({ threadId });
        workers.delete(threadId);
      } catch (error) { bb.log.warn(`Prediction helper archive: ${String(error)}`); }
      finally {
        workerReleases.delete(threadId);
        rejectedWorkers.delete(threadId); promptedWorkers.delete(threadId); approvalRequested.delete(threadId);
        revealedWorkers.delete(threadId); presentingApproval.delete(threadId); wakeups.delete(threadId);
      }
    })();
    workerReleases.set(threadId, release);
    return release;
  }
  // Provider archive can take a while. The suggestion does not wait for it.
  function releaseInBackground(threadId: string): void {
    void releaseWorker(threadId);
  }
  // Hidden threads are not in the sidebar, so the approval card would never
  // appear. Show the helper and open it beside the conversation.
  function presentApproval(threadId: string): Promise<void> {
    const current = presentingApproval.get(threadId);
    if (current) return current;
    const task = (async () => {
      await bb.sdk.threads.update({ threadId, visibility: "visible" });
      revealedWorkers.add(threadId);
      await bb.sdk.threads.open({ threadId, file: null, split: "right" });
    })();
    presentingApproval.set(threadId, task);
    void task.then(() => {}, () => { if (presentingApproval.get(threadId) === task) presentingApproval.delete(threadId); });
    return task;
  }
  async function waitForWorker(threadId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>(resolve => {
      const wake = () => { clearTimeout(timer); wakeups.delete(threadId); signal.removeEventListener("abort", wake); resolve(); };
      const timer = setTimeout(wake, 2000);
      wakeups.set(threadId, wake);
      signal.addEventListener("abort", wake, { once: true });
    });
  }
  const coordinator = new PredictionCoordinator<PredictionSource>({
    cache,
    source,
    async generate(threadId, snapshot, parentSignal) {
      const execution = snapshot.execution;
      const asksForApproval = execution.permissionMode !== "auto";
      let signal = parentSignal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timeout = new AbortController();
      let holdingForApproval = false;
      // The 60s bound covers the model request. It does not cover a person
      // answering an approval; that wait ends when they answer or the conversation moves on.
      const armTimeout = () => {
        clearTimeout(timer);
        if (timeout.signal.aborted) timeout = new AbortController();
        timer = setTimeout(() => timeout.abort(), 60_000);
        signal = AbortSignal.any([parentSignal, timeout.signal]);
      };
      const holdForApproval = () => {
        clearTimeout(timer);
        timer = undefined;
        signal = parentSignal;
        holdingForApproval = true;
      };
      armTimeout();
      try {
        signal.throwIfAborted();
        const worker = await bb.sdk.threads.spawn({
          projectId: execution.projectId,
          environment: execution.environmentId ? { type: "reuse", environmentId: execution.environmentId } : { type: "project-default" },
          providerId: execution.providerId, model: snapshot.model, reasoningLevel: execution.reasoningLevel,
          ...(execution.serviceTier ? { serviceTier: execution.serviceTier } : {}),
          permissionMode: execution.permissionMode, visibility: "hidden", title: WORKER_TITLE,
          pluginMetadata: { predictionWorker: true }, prompt: generationPrompt(snapshot.conversation),
        });
        workers.add(worker.id);
        if (asksForApproval) promptedWorkers.add(worker.id);
        try {
          // An interaction can be committed before spawn() resolves, before the
          // event listener can recognise this id as one of our workers.
          const pendingAtStart = await bb.sdk.threads.interactions.list({ threadId: worker.id, signal });
          if (pendingAtStart.length > 0) {
            if (!asksForApproval) throw new Error("Prediction helper requested an interaction");
            approvalRequested.add(worker.id);
          }
          for (;;) {
            parentSignal.throwIfAborted();
            if (asksForApproval && approvalRequested.has(worker.id) && !holdingForApproval) holdForApproval();
            const pending = asksForApproval && (await bb.sdk.threads.interactions.list({ threadId: worker.id, signal })).length > 0;
            if (pending) {
              approvalRequested.add(worker.id);
              if (!holdingForApproval) holdForApproval();
              try { await presentApproval(worker.id); }
              catch (error) { bb.log.warn(`Prediction helper approval: ${String(error)}`); }
            } else {
              if (asksForApproval) approvalRequested.delete(worker.id);
              if (holdingForApproval) { holdingForApproval = false; armTimeout(); }
              signal.throwIfAborted();
              if (rejectedWorkers.has(worker.id)) throw new Error("Prediction helper requested an interaction");
              const current = await bb.sdk.threads.get({ threadId: worker.id, signal });
              if (current.status === "error" || current.archivedAt || current.deletedAt) throw new Error("Prediction helper failed");
              if (current.status === "idle") {
                const { output } = await bb.sdk.threads.output({ threadId: worker.id, signal });
                if (output?.trim()) return parsePrediction(output);
              }
            }
            await waitForWorker(worker.id, signal);
          }
        } finally { releaseInBackground(worker.id); }
      } finally { clearTimeout(timer); }
    },
    changed: threadId => bb.realtime.publish(CHANNEL, { threadId }),
    log: error => bb.log.warn(`Prediction unavailable: ${String(error)}`),
  });
  settings.onChange(next => {
    config = next;
    clearPredictions();
  });
  bb.agents.configure(({ thread, pluginMetadata }) =>
    thread.title === WORKER_TITLE && pluginMetadata.predictionWorker === true
      ? { tools: [], skills: [], instructions: WORKER_INSTRUCTIONS }
      : { tools: [], skills: ["composer-predictions"] });

  function watch(threadId: string) {
    interested.add(threadId);
    if (interested.size > 1000) {
      const oldest = interested.values().next().value;
      if (oldest) { interested.delete(oldest); coordinator.clear(oldest); }
    }
  }
  bb.events.on("thread.idle", ({ thread }) => {
    wakeups.get(thread.id)?.();
    if (interested.has(thread.id)) coordinator.request(thread.id);
  });
  bb.events.on("thread.failed", ({ thread }) => { wakeups.get(thread.id)?.(); if (interested.has(thread.id)) coordinator.clear(thread.id); });
  for (const name of ["thread.active", "thread.archived", "thread.deleted"] as const) {
    bb.events.on(name, ({ thread }) => {
      if (interested.has(thread.id)) coordinator.clear(thread.id);
      if (name !== "thread.active") interested.delete(thread.id);
    });
  }
  for (const name of ["message.queued", "message.dispatched"] as const) {
    bb.events.on(name, ({ entry }) => { if (interested.has(entry.threadId)) coordinator.clear(entry.threadId); });
  }
  bb.events.on("interaction.pending", async ({ thread }) => {
    if (promptedWorkers.has(thread.id)) {
      approvalRequested.add(thread.id); wakeups.get(thread.id)?.();
      try { await presentApproval(thread.id); }
      catch (error) { bb.log.warn(`Prediction helper approval: ${String(error)}`); }
      return;
    }
    if (workers.has(thread.id)) {
      rejectedWorkers.add(thread.id); wakeups.get(thread.id)?.();
      // The generation's own cleanup stops the helper again, so a failure here only needs logging.
      try { await bb.sdk.threads.stop({ threadId: thread.id }); }
      catch (error) { bb.log.warn(`Prediction helper stop: ${String(error)}`); }
    } else if (interested.has(thread.id)) coordinator.clear(thread.id);
  });
  bb.rpc.register(rpcContract, {
    model_get: () => readModelSettings(),
    model_set: selection => changeModel(selection),
    model_clear: () => changeModel(null),
    get: ({ threadId }) => coordinator.get(threadId),
    ensure: ({ threadId }) => { watch(threadId); return coordinator.request(threadId); },
    regenerate: ({ threadId }) => { watch(threadId); coordinator.clear(threadId); return coordinator.request(threadId, true); },
    dismiss: ({ threadId, generationId }) => coordinator.dismiss(threadId, generationId),
  });
  bb.cli.register({
    name: "composer-predictions", summary: "Inspect or regenerate composer suggestions",
    commands: ["show", "regenerate", "dismiss"].map(name => ({ name, summary: `${name} a prediction`, usage: `bb composer-predictions ${name} <thread-id> [--json]` })),
    async run(argv) {
      const [command, threadId] = argv.filter(value => value !== "--json");
      if (!threadId || !["show", "regenerate", "dismiss"].includes(command)) return { exitCode: 0, stdout: "bb composer-predictions show|regenerate|dismiss <thread-id> [--json]" };
      if (command === "regenerate") { watch(threadId); coordinator.clear(threadId); coordinator.request(threadId, true); }
      if (command === "dismiss") coordinator.dismiss(threadId, coordinator.get(threadId).generationId);
      const state = coordinator.get(threadId);
      return { exitCode: 0, stdout: argv.includes("--json") ? JSON.stringify(state) : state.suggestion ?? state.status };
    },
  });
  bb.onDispose(async () => {
    await coordinator.dispose();
    await Promise.allSettled([...workers].map(threadId => releaseWorker(threadId)));
  });
  // Lifecycle events are not replayed after a process crash. Reconcile only
  // this plugin's marked, unarchived workers that have finished. A helper
  // opened for approval is visible; it is hidden again before it is archived.
  // The current conversation and a helper that is still running are left alone.
  // A failed lookup skips recovery for now; it must not stop the plugin loading.
  const abandoned: string[] = [];
  try {
    for (let offset = 0; ; offset += 100) {
      const rows = await bb.sdk.threads.list({ originPluginId: bb.pluginId, includeHidden: true, archived: false, limit: 100, offset });
      for (const row of rows) {
        if (row.originPluginId !== bb.pluginId || row.title !== WORKER_TITLE || row.archivedAt || row.deletedAt) continue;
        // A helper that is still running belongs to a live prediction, including
        // one waiting for approval. The next start releases it once that
        // prediction is idle or has failed.
        if (row.status !== "idle" && row.status !== "error") continue;
        try {
          const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: row.id, pluginId: bb.pluginId });
          if (metadata?.predictionWorker === true) {
            if (row.visibility === "visible") revealedWorkers.add(row.id);
            abandoned.push(row.id);
          }
        } catch (error) { bb.log.warn(`Prediction helper recovery skipped ${row.id}: ${String(error)}`); }
      }
      if (rows.length < 100) break;
    }
  } catch (error) { bb.log.warn(`Prediction helper recovery: ${String(error)}`); }
  for (const threadId of abandoned) { workers.add(threadId); await releaseWorker(threadId); }
}
