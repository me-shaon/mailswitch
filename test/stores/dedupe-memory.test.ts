import { MemoryDedupeStore } from "../../src/stores/memory";
import { dedupeStoreSuite } from "./dedupe-suite";

dedupeStoreSuite("memory", async () => new MemoryDedupeStore());
