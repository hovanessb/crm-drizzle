import { loadRootEnv } from "@crm/env";
import { databaseUrl, migrateDatabase } from "./migrations";

loadRootEnv();

await migrateDatabase(databaseUrl());
console.log("Database migrations are applied.");
