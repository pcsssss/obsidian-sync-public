/* Offline tests for generation-guarded GCS deletion. */
import { GcsProvider } from "../src/providers/gcs/GcsProvider";
import { sigv4Authorizer } from "../src/providers/gcs/auth";
import { PreconditionFailed, type HttpResponse, type HttpSend } from "../src/providers/RemoteProvider";

const response = (status: number, headers: Record<string, string> = {}): HttpResponse => ({
  status, headers, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0),
});

class FakeGcs {
  present = true;
  etag = "v1";
  generation = "100";
  changeBeforeDelete = false;
  deletes = 0;
  readonly http: HttpSend = async (method, _url, headers) => {
    if (method === "HEAD") return this.present ? response(200, { etag: `"${this.etag}"`, "x-goog-generation": this.generation }) : response(404);
    if (method === "DELETE") {
      if (this.changeBeforeDelete) { this.etag = "v2"; this.generation = "101"; }
      if (headers["x-goog-if-generation-match"] !== this.generation) return response(412);
      this.present = false;
      this.deletes++;
      return response(204);
    }
    throw new Error(`Unexpected ${method}`);
  };
  provider(): GcsProvider {
    return new GcsProvider({ bucket: "fake", prefix: "", endpoint: "https://example.invalid" }, async (_method, _url, _body, extra) => extra, this.http);
  }
}

async function rejected(op: () => Promise<unknown>): Promise<void> {
  try { await op(); } catch (e) { if (e instanceof PreconditionFailed) return; throw e; }
  throw new Error("Expected a precondition failure");
}

async function main(): Promise<void> {
  {
    const gcs = new FakeGcs();
    await gcs.provider().delete("note.md", { ifVersion: "v1" });
    if (gcs.present || gcs.deletes !== 1) throw new Error("Matching generation should delete once");
  }
  {
    const gcs = new FakeGcs();
    const message = await gcs.provider().delete("note.md").then(() => "", (e: Error) => e.message);
    if (!message || gcs.deletes) throw new Error("Deletion without an observed version must be refused");
  }
  {
    const gcs = new FakeGcs();
    await rejected(() => gcs.provider().delete("note.md", { ifVersion: "old" }));
    if (!gcs.present || gcs.deletes) throw new Error("A changed ETag must not be deleted");
  }
  {
    const gcs = new FakeGcs();
    gcs.changeBeforeDelete = true;
    await rejected(() => gcs.provider().delete("note.md", { ifVersion: "v1" }));
    if (!gcs.present || gcs.deletes) throw new Error("A changed generation must not be deleted");
  }
  {
    const gcs = new FakeGcs();
    gcs.generation = "";
    await rejected(() => gcs.provider().delete("note.md", { ifVersion: "v1" }));
    if (!gcs.present || gcs.deletes) throw new Error("Missing generation must fail closed");
  }
  {
    const gcs = new FakeGcs();
    gcs.present = false;
    await gcs.provider().delete("note.md", { ifVersion: "v1" });
    if (gcs.deletes) throw new Error("A missing object needs no deletion");
  }
  {
    const gcs = new FakeGcs();
    let signed = false;
    const http: HttpSend = async (method, url, headers, body) => {
      if (method === "DELETE") signed = (headers.authorization ?? "").includes("x-goog-if-generation-match");
      return gcs.http(method, url, headers, body);
    };
    const provider = new GcsProvider({ bucket: "fake", prefix: "", endpoint: "https://example.invalid" },
      sigv4Authorizer({ accessId: "fake-id", secret: "fake-secret" }, { region: "auto", service: "s3" }), http);
    await provider.delete("note.md", { ifVersion: "v1" });
    if (!signed) throw new Error("The deletion precondition must be included in the signed headers");
  }
  console.log("GCS conditional deletion: PASS (ETag and generation races)");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
