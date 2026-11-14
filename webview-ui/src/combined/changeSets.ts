// PURE: change sets — one author's commits in two or more repositories close together in time.
//
// Per author (by email, case-insensitive), commits are sorted by commit date and grouped from the
// first commit of a group: every commit at most `window` after that first one joins it, the next
// one starts a new group. A group that touches two or more repositories is a change set. So a set
// never spans more than the window ("within 15 minutes"), however long someone keeps committing;
// a plain gap-chain would merge an afternoon of work into one set.

export interface ChangeSetItem {
  key: string;
  repo: number;
  email: string;
  /** Unix seconds. */
  date: number;
}

export interface ChangeSet {
  id: string;
  members: string[];
  repos: number;
}

export function findChangeSets(items: readonly ChangeSetItem[], windowSeconds: number): { byKey: Map<string, ChangeSet>; sets: ChangeSet[] } {
  const byAuthor = new Map<string, ChangeSetItem[]>();
  for (const it of items) {
    const email = it.email.toLowerCase();
    const list = byAuthor.get(email) ?? [];
    list.push(it);
    byAuthor.set(email, list);
  }
  const sets: ChangeSet[] = [];
  const byKey = new Map<string, ChangeSet>();
  for (const [email, list] of byAuthor) {
    list.sort((a, b) => a.date - b.date || a.repo - b.repo);
    let chain: ChangeSetItem[] = [];
    const close = () => {
      const repos = new Set(chain.map((c) => c.repo)).size;
      if (repos >= 2) {
        const set: ChangeSet = { id: `${email}@${chain[0].date}`, members: chain.map((c) => c.key), repos };
        sets.push(set);
        for (const c of chain) byKey.set(c.key, set);
      }
      chain = [];
    };
    for (const it of list) {
      if (chain.length && it.date - chain[0].date > windowSeconds) close();
      chain.push(it);
    }
    close();
  }
  return { byKey, sets };
}
