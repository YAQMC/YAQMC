import type { PluginDefinition } from './sdk';
declare global {
  function definePlugin(definition: PluginDefinition): PluginDefinition;
}
