/**
 * The target application: a legacy credit-union back office.
 *
 * Built rather than borrowed. A public demo site would have been safer, but it
 * would also have let us dodge the exact reality the brief describes — no clean
 * DOM, no test ids, and runtime exceptional states we need to trigger on
 * demand. A local app is reproducible, PII-free, and lets us INJECT the failure
 * modes the brief names instead of waiting for them.
 */

import express from "express";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import { findMember, searchMembers, type Member } from "./data/seed.js";
import { variantFor, type Variant } from "./variants/index.js";
import * as V from "./views/index.js";
import {
  arm,
  clearInjections,
  listInjections,
  seededInterstitial,
  takeInjection,
  type InjectionMode,
} from "./inject.js";

/** Idle timeout before the session interstitial appears. */
const IDLE_TIMEOUT_MS = Number(process.env.LEGACY_CU_IDLE_MS ?? 30 * 60 * 1000);
/** The "unexpected dialog" fires on every Nth member-detail load. 0 disables. */
const INTERSTITIAL_EVERY_NTH = Number(process.env.LEGACY_CU_INTERSTITIAL_NTH ?? 4);

interface Session {
  id: string;
  lastSeen: number;
  expired: boolean;
}

export function createApp(): express.Express {
  const sessions = new Map<string, Session>();
  clearInjections();
  const app = express();
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  /* ------------------------------------------------------ control plane ---- */
  /* Out-of-band fault arming. Not part of the app's own surface: the automation
   * never navigates here, so injected faults never change the URLs a capability
   * recorded. See apps/legacy-cu/inject.ts for why that matters. */

  app.post("/__control/inject", (req, res) => {
    const mode = String(req.body?.mode ?? "") as InjectionMode;
    const count = Number(req.body?.count ?? 1);
    const pathContains = req.body?.pathContains ? String(req.body.pathContains) : undefined;
    const valid: InjectionMode[] = [
      "session_timeout",
      "transient_503",
      "app_error_500",
      "interstitial",
      "slow_load",
    ];
    if (!valid.includes(mode)) {
      res.status(400).json({ error: `unknown mode: ${mode}`, valid });
      return;
    }
    arm(mode, count, pathContains);
    res.json({ armed: listInjections() });
  });

  app.post("/__control/reset", (_req, res) => {
    clearInjections();
    sessions.clear();
    res.json({ ok: true });
  });

  app.get("/__control/state", (_req, res) => {
    res.json({ armed: listInjections(), sessions: sessions.size });
  });

  /* ----------------------------------------------------------- middleware -- */

  function currentVariant(req: express.Request): Variant {
    return variantFor(String(req.query.variant ?? req.body?.variant ?? "variant-a"));
  }

  /** Session handling + fault injection, applied to every app-surface route. */
  app.use("/frame", (req, res, next) => {
    const v = currentVariant(req);
    const path = req.originalUrl;

    const injected = takeInjection(path);

    if (injected === "app_error_500") {
      res.status(500).send(V.appError(v, randomUUID().slice(0, 8)));
      return;
    }
    if (injected === "transient_503") {
      res
        .status(503)
        .set("Retry-After", "1")
        .send(
          `<html><head><title>503 Service Unavailable</title></head><body>
       <h1>Service Unavailable</h1><p>The core banking host is not responding. Retry shortly.</p></body></html>`,
        );
      return;
    }

    // Session bookkeeping.
    let sid = req.cookies?.SESSIONID as string | undefined;
    let session = sid ? sessions.get(sid) : undefined;
    if (!session) {
      sid = randomUUID();
      session = { id: sid, lastSeen: Date.now(), expired: false };
      sessions.set(sid, session);
      res.cookie("SESSIONID", sid, { httpOnly: false, sameSite: "lax" });
    }
    if (injected === "session_timeout") session.expired = true;
    if (Date.now() - session.lastSeen > IDLE_TIMEOUT_MS) session.expired = true;

    // The login interstitial is itself reachable, or we could never recover.
    const isLoginRoute = req.path === "/login";
    if (session.expired && !isLoginRoute) {
      res.status(200).send(V.loginInterstitial(v, path));
      return;
    }
    session.lastSeen = Date.now();

    if (injected === "slow_load") {
      setTimeout(next, Number(process.env.LEGACY_CU_SLOW_MS ?? 3000));
      return;
    }
    if (injected === "interstitial") {
      res.status(200).send(V.interstitialDialog(v, path));
      return;
    }
    next();
  });

  /* --------------------------------------------------------------- routes -- */

  app.get("/", (req, res) => {
    const v = currentVariant(req);
    res.send(V.shell(v, `/frame/search?variant=${v.id}`));
  });

  app.get("/frame/nav", (req, res) => res.send(V.navFrame(currentVariant(req))));

  app.get("/frame/unavailable", (req, res) => res.send(V.unavailable(currentVariant(req))));

  app.get("/frame/search", (req, res) => {
    const v = currentVariant(req);
    res.send(V.searchPage(v, req.query.err ? String(req.query.err) : undefined));
  });

  app.post("/frame/login", (req, res) => {
    const sid = req.cookies?.SESSIONID as string | undefined;
    const session = sid ? sessions.get(sid) : undefined;
    if (session) {
      session.expired = false;
      session.lastSeen = Date.now();
    }
    const returnTo = String(req.body?.returnTo ?? "/frame/search");
    res.redirect(302, returnTo);
  });

  app.get("/frame/results", (req, res) => {
    const v = currentVariant(req);
    const q = String(req.query.q ?? "");

    // Validation error: a business-rule rejection, rendered on the form itself.
    if (q.trim() === "") {
      res.send(V.searchPage(v, `${v.memberIdLabel} is required.`));
      return;
    }
    if (!/^[0-9A-Za-z\- ]{1,12}$/.test(q.trim())) {
      res.send(V.searchPage(v, `${v.memberIdLabel} contains invalid characters.`));
      return;
    }

    const found = searchMembers(q);
    if (found.length === 0) {
      res.send(V.noResultsPage(v, q));
      return;
    }
    res.send(V.resultsPage(v, found, q));
  });

  function withMember(
    req: express.Request,
    res: express.Response,
    fn: (v: Variant, m: Member) => void,
  ): void {
    const v = currentVariant(req);
    const id = String(req.params.id ?? "");
    const m = findMember(id);
    if (!m) {
      res.status(200).send(V.noResultsPage(v, id));
      return;
    }
    if (m.restricted) {
      res.status(200).send(V.permissionDenied(v, id));
      return;
    }
    fn(v, m);
  }

  app.get("/frame/member/:id", (req, res) => {
    withMember(req, res, (v, m) => {
      // The seeded "unexpected confirmation dialog": deterministic, every Nth load.
      if (seededInterstitial("member-detail", INTERSTITIAL_EVERY_NTH)) {
        res.send(V.interstitialDialog(v, `/frame/member/${m.memberId}?variant=${v.id}`));
        return;
      }
      res.send(V.memberDetail(v, m));
    });
  });

  app.get("/frame/accounts/:id", (req, res) => {
    withMember(req, res, (v, m) => res.send(V.accountsFrame(v, m)));
  });

  app.get("/frame/subaccount/:id", (req, res) => {
    withMember(req, res, (v, m) => res.send(V.subAccountForm(v, m, {}, [])));
  });

  app.post("/frame/subaccount/:id", (req, res) => {
    withMember(req, res, (v, m) => {
      const draft = {
        kind: String(req.body?.kind ?? ""),
        nickname: String(req.body?.nickname ?? ""),
        initialDeposit: String(req.body?.initialDeposit ?? ""),
      };
      const errors: string[] = [];
      if (draft.kind === "") errors.push("Account Type must be selected.");
      if (draft.nickname.trim().length < 3) errors.push("Nickname must be at least 3 characters.");
      if (!/^\d+(\.\d{1,2})?$/.test(draft.initialDeposit.trim()))
        errors.push("Initial Deposit must be a numeric amount.");
      else if (Number(draft.initialDeposit) < 25)
        errors.push("Initial Deposit must be at least $25.00.");

      if (errors.length > 0) {
        res.send(V.subAccountForm(v, m, draft, errors));
        return;
      }
      if (v.subAccountReviewStep) {
        res.send(V.subAccountReview(v, m, draft));
        return;
      }
      res.send(V.subAccountConfirmation(v, m, draft, nextAccountNumber(m)));
    });
  });

  app.post("/frame/subaccount/:id/commit", (req, res) => {
    withMember(req, res, (v, m) => {
      const draft = {
        kind: String(req.body?.kind ?? ""),
        nickname: String(req.body?.nickname ?? ""),
        initialDeposit: String(req.body?.initialDeposit ?? ""),
      };
      res.send(V.subAccountConfirmation(v, m, draft, nextAccountNumber(m)));
    });
  });

  /** Deterministic so the confirmation screen is assertable across runs. */
  function nextAccountNumber(m: Member): string {
    const base = m.accounts[0]?.accountNumber.split("-").slice(0, 2).join("-") ?? "4417-00000";
    const next = String(m.accounts.length + 1).padStart(2, "0");
    return `${base}-${next}`;
  }

  return app;
}
