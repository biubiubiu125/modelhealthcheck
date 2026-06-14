import {getStorageDiagnosticsDataResponse} from "@/lib/admin/storage-diagnostics-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return getStorageDiagnosticsDataResponse(request);
}
