import { startFakeProvider } from "../test/fake-provider";

const fake = startFakeProvider({ port: 4010 });
console.log(`fake sforum provider: ${fake.url}`);
