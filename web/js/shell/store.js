const listeners = new Set();

export const shellStore = {
  state: {
    selectedNode: null,
    lastResult: null,
    catalog: {
      facilities: [],
      allRecipes: [],
      visibleRecipes: [],
      recentRecipes: [],
      facilityFilter: "",
      searchText: "",
      showAllFilling: false,
      components: [],
    },
    plans: [],
    planSearch: "",
    warnCount: 0,
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  patch(patch) {
    Object.assign(this.state, patch);
    for (const listener of listeners) listener(this.state);
  },
};
