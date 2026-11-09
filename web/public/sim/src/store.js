// localStorage wrapper. Never throws; returns null when storage is missing (Node, private windows, blocked frames).
export const store = {
  get(k) { try { if (typeof localStorage === 'undefined') return null; return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { if (typeof localStorage === 'undefined') return; localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } }
};
