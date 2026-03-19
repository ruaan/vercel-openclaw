import { jsonOk } from "@/shared/http";
import { requireMutationAuth } from "@/server/auth/route-auth";
import { requireDebugEnabled } from "@/server/auth/debug-guard";
import {
  getAiGatewayBearerTokenOptional,
  resolveAiGatewayCredentialOptional,
  isVercelDeployment,
} from "@/server/env";

export async function POST(request: Request): Promise<Response> {
  const blocked = requireDebugEnabled();
  if (blocked) return blocked;

  const auth = await requireMutationAuth(request);
  if (auth instanceof Response) return auth;

  const timings: Record<string, number> = {};

  const t0 = performance.now();
  const cred1 = await resolveAiGatewayCredentialOptional();
  timings.resolveCredential1Ms = performance.now() - t0;

  const t1 = performance.now();
  await resolveAiGatewayCredentialOptional();
  timings.resolveCredential2Ms = performance.now() - t1;

  const t2 = performance.now();
  await getAiGatewayBearerTokenOptional();
  timings.bearerToken1Ms = performance.now() - t2;

  const t3 = performance.now();
  await getAiGatewayBearerTokenOptional();
  timings.bearerToken2Ms = performance.now() - t3;

  return jsonOk({
    timings,
    credentialAvailable: cred1 !== null,
    isVercelDeployment: isVercelDeployment(),
  });
}
