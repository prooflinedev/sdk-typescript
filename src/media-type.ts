/** Return the normalized HTTP media type without parameters. */
export function mediaType(headers: Headers): string | undefined {
  return headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}
