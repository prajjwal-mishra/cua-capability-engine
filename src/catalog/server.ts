/**
 * HTTP face of the catalog.
 *
 * Small on purpose. The interesting artifact is the CONTRACT this serves —
 * `GET /capabilities` returns JSON Schema an agent framework can register as
 * tools without any adapter code, and `POST /capabilities/:id/invoke` returns
 * the replay result union unchanged. Anything more (auth, tenancy resolution,
 * queueing, idempotency keys) is real production work that the brief
 * explicitly does not want built here, and is listed in REPORT.md § Cuts.
 */

import express from "express";
import { invokeCapability, listCatalog, CapabilityNotInvocable, entryFor } from "./catalog.js";
import { ArtifactStore } from "../artifact/store.js";
import { InputValidationError } from "../replay/executor.js";
import { catalogApp } from "./ui.js";

export async function startCatalogServer(
  port: number,
  store: ArtifactStore = new ArtifactStore(),
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.type("html").send(catalogApp());
  });

  app.get("/capabilities", (_req, res) => {
    res.json(listCatalog(store));
  });

  app.get("/capabilities/:id", (req, res) => {
    try {
      res.json(entryFor(store.load(req.params.id)));
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** The whole point: an agent calls this with typed args and gets the result
   *  contract back — including `business_outcome`, which is not an error. */
  app.post("/capabilities/:id/invoke", async (req, res) => {
    const body = (req.body ?? {}) as {
      args?: Record<string, unknown>;
      tenant?: string;
      allowWrites?: boolean;
      allowDraft?: boolean;
    };
    try {
      const result = await invokeCapability(req.params.id, body.args ?? {}, {
        tenant: body.tenant,
        allowWrites: body.allowWrites,
        allowDraft: body.allowDraft,
        store,
      });
      // 200 for every arm of the union that reached the application, including
      // business outcomes and escalations. HTTP status describes the call; the
      // result's `status` describes what the bank's software said.
      res.status(result.status === "failed" ? 502 : 200).json(result);
    } catch (err) {
      if (err instanceof CapabilityNotInvocable) {
        res.status(403).json({ status: "rejected", reason: err.message });
        return;
      }
      if (err instanceof InputValidationError) {
        res.status(400).json({ status: "rejected", reason: err.message });
        return;
      }
      res.status(500).json({
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });

  // Report the port that was actually bound, not the one that was asked for.
  // They differ whenever 0 is passed to mean "any free port".
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://127.0.0.1:${bound}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
