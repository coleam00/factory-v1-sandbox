import { readFactoryConfig } from "../../../../scripts/factory-config.ts";
const { holdouts } = readFactoryConfig();
console.log(JSON.stringify(holdouts));
