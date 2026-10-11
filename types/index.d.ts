export type PromptLibraryView = {
  query: string;
  selected: string | null;
  mode: 'browse' | 'fill' | 'confirm';
  message: string;
  rev: number;
};

declare module 'claude-code' {
  interface PluginState {
    'prompt-library': { view: PromptLibraryView };
  }
}
