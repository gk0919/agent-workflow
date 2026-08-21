/** JSON values accepted at plugin, process and remote trust boundaries. */
export type PluginJsonPrimitive = boolean | null | number | string;
export type PluginJsonValue = PluginJsonPrimitive | PluginJsonObject | PluginJsonValue[];

export interface PluginJsonObject {
  [key: string]: PluginJsonValue | undefined;
}
