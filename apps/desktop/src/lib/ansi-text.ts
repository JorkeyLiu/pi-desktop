/*
 * Terminal colour, parsed rather than interpreted (D226 follow-up).
 *
 * A command's output is the one payload that may arrive with ANSI SGR codes in
 * it, and the only safe way to show those in a renderer is to read them into
 * styled text — never to hand the escape sequence to `innerHTML`. Everything
 * that is not a colour (cursor movement, erase, OSC titles) is dropped, so a
 * progress-spinner command cannot paint over the transcript.
 */

export type AnsiStyle = {
  bold: boolean;
  underline: boolean;
  /** Empty for the terminal's default foreground. */
  color: string;
};

export type AnsiSegment = { text: string; style: AnsiStyle };

const SGR_PATTERN = /^\u001b\[([0-9;]*)m/;
const CSI_PATTERN = /^\u001b\[[0-9;?]*[A-Za-z]/;
const OSC_PATTERN = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/;

const ANSI_COLORS: Record<number, string> = {
  30: "black",
  31: "red",
  32: "green",
  33: "yellow",
  34: "blue",
  35: "magenta",
  36: "cyan",
  37: "white",
  39: "",
  90: "gray",
  91: "bright-red",
  92: "bright-green",
  93: "bright-yellow",
  94: "bright-blue",
  95: "bright-magenta",
  96: "bright-cyan",
  97: "bright-white",
};

const DEFAULT_STYLE: AnsiStyle = { bold: false, underline: false, color: "" };

/** Whether the text carries any escape sequence at all. */
export function hasAnsi(text: string): boolean {
  return text.includes("\u001b");
}

function applySgr(style: AnsiStyle, codes: string): AnsiStyle {
  const next: AnsiStyle = { ...style };
  for (const code of codes.split(";")) {
    const value = code === "" ? 0 : Number(code);
    if (value === 0) {
      next.bold = false;
      next.underline = false;
      next.color = "";
    } else if (value === 1) {
      next.bold = true;
    } else if (value === 22) {
      next.bold = false;
    } else if (value === 4) {
      next.underline = true;
    } else if (value === 24) {
      next.underline = false;
    } else if (value in ANSI_COLORS) {
      next.color = ANSI_COLORS[value];
    }
  }
  return next;
}

function sameStyle(left: AnsiStyle, right: AnsiStyle): boolean {
  return (
    left.bold === right.bold &&
    left.underline === right.underline &&
    left.color === right.color
  );
}

/**
 * Split text into styled runs. Escape sequences never survive into the runs;
 * an unterminated one is dropped rather than shown as mojibake.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let style = DEFAULT_STYLE;
  let index = 0;
  const push = (value: string) => {
    if (value === "") return;
    const last = segments[segments.length - 1];
    if (last && sameStyle(last.style, style)) {
      last.text += value;
      return;
    }
    segments.push({ text: value, style });
  };

  while (index < text.length) {
    if (text.charCodeAt(index) !== 27) {
      const escapeAt = text.indexOf("\u001b", index);
      const end = escapeAt === -1 ? text.length : escapeAt;
      push(text.slice(index, end));
      index = end;
      continue;
    }
    const rest = text.slice(index);
    const sgr = rest.match(SGR_PATTERN);
    if (sgr) {
      style = applySgr(style, sgr[1]);
      index += sgr[0].length;
      continue;
    }
    const other =
      rest.match(CSI_PATTERN)?.[0] ?? rest.match(OSC_PATTERN)?.[0] ?? null;
    index += other ? other.length : 1;
  }
  return segments;
}
