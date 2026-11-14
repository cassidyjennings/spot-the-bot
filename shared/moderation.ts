// Small, deliberately conservative word list: used to HIGHLIGHT questions for instructors
// (never auto-block) and to reject group names. Extend as needed.
const WORDS = [
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'asshole', 'bastard', 'slut', 'whore',
  'nigg', 'fag', 'retard', 'rape', 'porn', 'sex', 'nude', 'naked', 'kill yourself', 'kys', 'suicide',
  'penis', 'vagina', 'boob', 'tits', 'horny', 'nazi', 'hitler',
];

const leet: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
const normalize = (s: string) =>
  s.toLowerCase().replace(/[013457@$]/g, (c) => leet[c] ?? c);

export function flaggedTerms(text: string): string[] {
  const t = normalize(text);
  return WORDS.filter((w) => t.includes(w));
}

/** Returns an error message, or null if the name is fine. */
export function validateGroupName(raw: string): string | null {
  const name = raw.trim();
  if (name.length < 2 || name.length > 20) return 'Group name must be 2-20 characters.';
  if (!/^[\p{L}\p{N} _\-'!.?]+$/u.test(name)) return 'Use letters, numbers and spaces only.';
  if (/\d{4,}/.test(name)) return "Don't put numbers like phone numbers in your name.";
  if (flaggedTerms(name).length) return 'Pick a different group name.';
  return null;
}

export function cleanText(raw: unknown, max: number): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}
