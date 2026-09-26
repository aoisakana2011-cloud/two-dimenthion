'use strict';

// Keep only revisions that clients may still be using. Unchanged polls reuse
// the same token, so large projects do not accumulate snapshots every tick.
class ProjectChangeTracker {
  constructor(scan, historyLimit = 32) {
    this.scan = scan;
    this.historyLimit = historyLimit;
    this.root = null;
    this.revision = 0;
    this.snapshot = null;
    this.history = [];
    this.pending = Promise.resolve();
  }

  changes(root, since = '') {
    const work = this.pending.then(() => this.check(root, since));
    this.pending = work.catch(() => {});
    return work;
  }

  async check(root, since) {
    const next = await this.scan(root);
    if (this.root !== root || !this.snapshot) {
      this.root = root;
      this.snapshot = next;
      this.revision++;
      this.history = [];
    } else {
      const added = [], changed = [], removed = [];
      for (const [name, signature] of next) {
        if (!this.snapshot.has(name)) added.push(name);
        else if (this.snapshot.get(name) !== signature) changed.push(name);
      }
      for (const name of this.snapshot.keys()) if (!next.has(name)) removed.push(name);
      if (added.length || changed.length || removed.length) {
        this.snapshot = next;
        this.revision++;
        this.history.push({ revision: this.revision, added, changed, removed });
        if (this.history.length > this.historyLimit) this.history.shift();
      }
    }
    const token = `${this.root}:${this.revision}`;
    const requested = Number(String(since).slice(this.root.length + 1));
    if (!since || !String(since).startsWith(`${this.root}:`) || !Number.isSafeInteger(requested)
      || requested > this.revision || requested < this.revision - this.history.length) {
      return { root: this.root, token, reset: true, added: [], changed: [], removed: [] };
    }
    const events = this.history.filter((entry) => entry.revision > requested);
    // Collapse a burst of add/change/delete into the current state relative to
    // the client's revision, without sending entire directory listings.
    const before = new Map();
    for (const event of events) {
      for (const name of event.added) if (!before.has(name)) before.set(name, 'absent');
      for (const name of event.changed) if (!before.has(name)) before.set(name, 'present');
      for (const name of event.removed) if (!before.has(name)) before.set(name, 'present');
    }
    const added = [], changed = [], removed = [];
    for (const [name, original] of before) {
      if (this.snapshot.has(name)) (original === 'absent' ? added : changed).push(name);
      else if (original === 'present') removed.push(name);
    }
    return { root: this.root, token, reset: false, added, changed, removed };
  }
}

module.exports = { ProjectChangeTracker };
