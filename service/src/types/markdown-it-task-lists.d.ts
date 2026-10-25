/**
 * `markdown-it-task-lists` ships no types. Only the default export is used, and only with
 * the options this project passes (`enabled: false` = read-only checkboxes), so a minimal
 * declaration is honest about the surface we depend on.
 */
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";

  export type TaskListOptions = {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  };

  const plugin: MarkdownIt.PluginWithOptions<TaskListOptions>;
  export default plugin;
}
