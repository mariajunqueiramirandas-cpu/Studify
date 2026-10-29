// Every data endpoint (define.ts), one module per app feature. The route names join the function table (routes.ts).
import { handlerOf, type DataRoute } from './define.ts';
import { routes as subjectsRoutes } from './subjects.ts';
import { routes as goalsRoutes } from './goals.ts';
import { routes as calendarRoutes } from './calendar.ts';
import { routes as provaRoutes } from './prova.ts';
import { routes as retroRoutes } from './retro.ts';
import { routes as energyRoutes } from './energy.ts';
import { routes as wellbeingRoutes } from './wellbeing.ts';
import { routes as motivationRoutes } from './motivation.ts';
import { routes as enemRoutes } from './enem.ts';
import { routes as skilltreeRoutes } from './skilltree.ts';
import { routes as trailRoutes } from './trail.ts';
import { routes as visualsRoutes } from './visuals.ts';
import { routes as progressRoutes } from './progress.ts';
import { routes as classRoutes } from './class.ts';
import { routes as roomsRoutes } from './rooms.ts';
import { routes as learnRoutes } from './learn.ts';
import { routes as practiceRoutes } from './practice.ts';
import { routes as mnemonicsRoutes } from './mnemonics.ts';
import { routes as tutorRoutes } from './tutor.ts';
import { routes as cameraRoutes } from './camera.ts';
import { routes as profileRoutes } from './profile.ts';
import { routes as notificationsRoutes } from './notifications.ts';
import { routes as podcastRoutes } from './podcast.ts';
import { routes as materialRoutes } from './material.ts';
import { routes as syncRoutes } from './sync.ts';

export const DATA_ROUTES: readonly DataRoute[] = [
  ...subjectsRoutes,
  ...goalsRoutes,
  ...calendarRoutes,
  ...provaRoutes,
  ...retroRoutes,
  ...energyRoutes,
  ...wellbeingRoutes,
  ...motivationRoutes,
  ...enemRoutes,
  ...skilltreeRoutes,
  ...trailRoutes,
  ...visualsRoutes,
  ...progressRoutes,
  ...classRoutes,
  ...roomsRoutes,
  ...learnRoutes,
  ...practiceRoutes,
  ...mnemonicsRoutes,
  ...tutorRoutes,
  ...cameraRoutes,
  ...profileRoutes,
  ...notificationsRoutes,
  ...podcastRoutes,
  ...materialRoutes,
  ...syncRoutes,
];

/** name -> handler. A name used twice stops the server at startup. */
export function dataHandlers(): Map<string, ReturnType<typeof handlerOf>> {
  const out = new Map<string, ReturnType<typeof handlerOf>>();
  for (const route of DATA_ROUTES) {
    if (out.has(route.name)) throw new Error(`data route ${route.name} is defined twice`);
    out.set(route.name, handlerOf(route));
  }
  return out;
}
