import { after, NextResponse } from "next/server";

import { requireAdminAuth } from "@/server/auth/admin-auth";
import { getPublicOrigin } from "@/server/public-url";
import { resetSandbox } from "@/server/sandbox/lifecycle";

export async function POST(request: Request): Promise<Response> {
  const auth = await requireAdminAuth(request);
  if (auth instanceof Response) return auth;

  after(() => resetSandbox({ origin: getPublicOrigin(request), reason: "admin.reset" }));
  return NextResponse.json({ ok: true, message: "Sandbox reset started" });
}
