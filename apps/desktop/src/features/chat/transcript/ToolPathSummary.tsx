import { toolPathName } from "../../../lib/tool-path-display";

/**
 * The path hint of a collapsed tool row.
 *
 * A file row names its file and nothing else: the hint is scanned, not read,
 * and the last segment is what a reader matches on. The name stays inside the
 * row at every width because the row ellipsizes it
 * (`.tool-row-summary.is-path`), and the whole raw path is one hover away in the
 * row's title, in its file menu and in its preview target. Nothing here is
 * measured, so a transcript of a hundred file rows costs one line of text per
 * row instead of a layout per path candidate.
 */
export function ToolPathSummary({ path }: { path: string }) {
  return <>{toolPathName(path)}</>;
}
