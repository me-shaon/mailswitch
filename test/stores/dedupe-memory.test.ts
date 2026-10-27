import { MemoryDedupeStore } from "../../src/stores/memory";
import { dedupeBulkSuite, dedupeStoreSuite } from "./dedupe-suite";

dedupeStoreSuite("memory", async () => new MemoryDedupeStore());
dedupeBulkSuite("memory", async () => new MemoryDedupeStore());
