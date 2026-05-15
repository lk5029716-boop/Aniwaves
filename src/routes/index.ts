import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import animeRouter from "./anime.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(animeRouter);

export default router;
