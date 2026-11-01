// relay/main.js — Arranca el repetidor de respaldo en Deno Deploy.
// Toda la lógica está en relay.js (que no depende de Deno y se prueba con Node). Ver docs/RESPALDO.md.
import { handle } from "./relay.js";

Deno.serve((req) => handle(req));
