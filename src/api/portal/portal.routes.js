// =============================================================
// Public portal routes — no authentication required.
//
//   GET  /portal/:slug        — fetch portal + content
//   POST /portal/:slug/auth   — verify portal password
// =============================================================

import { Router } from "express";
import { wrap } from "../../utils/response.util.js";
import * as ctrl from "./portal.controller.js";

const router = Router();

router.get("/:slug", wrap(ctrl.getPublicPortal));
router.post("/:slug/auth", wrap(ctrl.authPortal));

export default router;
