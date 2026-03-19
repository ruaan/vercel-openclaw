/**
 * Gate debug routes behind the ENABLE_DEBUG_ROUTES env var.
 * Returns a 404 response when the guard is not satisfied, or null to proceed.
 */
export function requireDebugEnabled(): Response | null {
  if (!process.env.ENABLE_DEBUG_ROUTES) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}
