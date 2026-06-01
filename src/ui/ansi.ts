// OSC 8 terminal hyperlink — clickable in modern terminals (iTerm2, macOS Terminal, VS Code, WezTerm…).
// Degrades to just showing `text` in terminals that don't support it.
export function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}
