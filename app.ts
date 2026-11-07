import type { Answer, Result, Sources, Storage } from './app.contract.d.ts';

export const grants = 'fs.read app:/data/catalog.json\nfs.write app:/data/catalog.json';

const FILE = 'app:/data/catalog.json';
type Catalog = Result<'loadCatalog'>;
type Thread = Catalog['threads'][number];

const seed: Catalog = {
  environments: [
    { id: 'macbook', label: 'MacBook Pro', url: 'http://192.168.1.24:3773', status: 'Connected', enabled: true },
    { id: 'moonbase', label: 'Moonbase Terminal', url: 'https://moonbase.t3.sh', status: 'Connected', enabled: true },
    { id: 'pocket-pi', label: 'Pocket Pi', url: 'https://pocket-pi.t3.sh', status: 'Available', enabled: false },
  ],
  threads: [
    {
      id: 'offline-launch',
      environmentId: 'macbook',
      project: 'T3 Code',
      title: 'Ship the offline launch checklist',
      status: 'Waiting',
      updatedAt: '8m ago',
      messages: [
        { id: 'offline-launch-1', role: 'user', body: 'Ship the offline launch checklist before touchdown.', createdAt: '09:24' },
        { id: 'offline-launch-2', role: 'assistant', body: 'I will check the mobile startup path, cache the last environment snapshot, and verify the reconnect flow.', createdAt: '09:25' },
      ],
    },
    {
      id: 'suspense-handoff',
      environmentId: 'moonbase',
      project: 'React',
      title: 'Polish the Suspense handoff',
      status: 'Working',
      updatedAt: '27m ago',
      messages: [
        { id: 'suspense-handoff-1', role: 'user', body: 'Polish the Suspense handoff for the train tunnel.', createdAt: '09:05' },
        { id: 'suspense-handoff-2', role: 'assistant', body: 'The handoff is staged. I am checking the loading boundary and the final transition now.', createdAt: '09:08' },
      ],
    },
    {
      id: 'remote-command',
      environmentId: 'moonbase',
      project: 'T3 Code',
      title: 'Remote command center',
      status: 'Done',
      updatedAt: '1h ago',
      messages: [
        { id: 'remote-command-1', role: 'user', body: 'Make the remote command center ready for review.', createdAt: '08:12' },
        { id: 'remote-command-2', role: 'assistant', body: 'The command center is ready. All checks passed and the review notes are attached.', createdAt: '08:18' },
      ],
    },
  ],
};

async function load(storage: Storage): Promise<Catalog> {
  try {
    const bytes = await storage.fs.readFile(FILE);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Catalog;
    if (Array.isArray(value.environments) && Array.isArray(value.threads)) return value;
  } catch {}
  return structuredClone(seed);
}

async function save(storage: Storage, catalog: Catalog): Promise<Result<'command'>> {
  await storage.fs.atomicWriteFile(FILE, new TextEncoder().encode(JSON.stringify(catalog)));
  return { ok: true, error: '' };
}

function appendMessage(thread: Thread, body: string): Thread {
  const number = thread.messages.length + 1;
  return {
    ...thread,
    status: 'Working',
    updatedAt: 'now',
    messages: thread.messages.concat([
      { id: `${thread.id}-${number}`, role: 'user', body, createdAt: 'now' },
      { id: `${thread.id}-${number + 1}`, role: 'assistant', body: `I received “${body}”. I am working on it in ${thread.project}.`, createdAt: 'now' },
    ]),
  };
}

const sources: Sources = {
  loadCatalog: async (_args, _store, storage): Promise<Result<'loadCatalog'>> => load(storage),
  command: async ([operation, id, value], _store, storage): Promise<Result<'command'>> => {
    const catalog = await load(storage);
    if (operation === 'toggle') {
      const environments = catalog.environments.map((environment) =>
        environment.id === id ? { ...environment, enabled: value === 'true' } : environment,
      );
      return save(storage, { ...catalog, environments });
    }
    if (operation === 'send' && typeof id === 'string' && typeof value === 'string' && value.trim() !== '') {
      const threads = catalog.threads.map((thread) => thread.id === id ? appendMessage(thread, value.trim()) : thread);
      return save(storage, { ...catalog, threads });
    }
    return { ok: false, error: 'The requested change is not available.' };
  },
};

export const answer: Answer = (source, args, store, storage, native) =>
  sources[source](args, store, storage, native);
