export function messageUrl(text: string) {
  const candidate = text.trim();
  if (!/^https?:\/\//i.test(candidate)) return null;

  try {
    return new URL(candidate).href;
  } catch {
    return null;
  }
}
