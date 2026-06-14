import "server-only";

import {NextResponse} from "next/server";

import {getAdminSession} from "@/lib/admin/auth";
import {getStorageDiagnosticsSnapshot} from "@/lib/admin/storage-diagnostics-cache";

export async function getStorageDiagnosticsDataResponse(request: Request): Promise<NextResponse> {
  const session = await getAdminSession();
  if (!session) {
    return NextResponse.json({message: "Unauthorized"}, {status: 401});
  }

  const url = new URL(request.url);
  const shouldForce = url.searchParams.get("force") === "1";
  const snapshot = getStorageDiagnosticsSnapshot({
    force: shouldForce,
    triggerRefresh: true,
  });

  return NextResponse.json(snapshot, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
