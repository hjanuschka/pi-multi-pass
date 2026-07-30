import assert from "node:assert/strict";
import { cloneKiroProviderConfig, refreshKiroCredential } from "../lib/provider-helpers.ts";

async function runApiKeyCheck() {
  let requests = 0;
  const credentials = {
    access: "ksk_account_2",
    refresh: "ksk_account_2|apikey",
    expires: 123,
    authMethod: "apikey",
    region: "us-east-1",
    profileArn: "arn:account-2",
  };
  const result = await refreshKiroCredential(credentials, {
    fetch: async () => { requests += 1; throw new Error("unexpected request"); },
  });
  assert.equal(result, credentials);
  assert.equal(requests, 0);
}

async function runDesktopCheck() {
  const calls = [];
  const result = await refreshKiroCredential({
    access: "old-account-2",
    refresh: "refresh-account-2|desktop",
    expires: 0,
    authMethod: "desktop",
    region: "eu-west-1",
    profileArn: "arn:account-2",
    startUrl: "https://account-2.awsapps.com/start",
  }, {
    now: () => 1_000_000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        accessToken: "new-account-2",
        refreshToken: "rotated-account-2",
        expiresIn: 3600,
      }), { status: 200 });
    },
  });
  assert.equal(calls[0].url, "https://prod.eu-west-1.auth.desktop.kiro.dev/refreshToken");
  assert.deepEqual(JSON.parse(calls[0].init.body), { refreshToken: "refresh-account-2" });
  assert.equal(result.access, "new-account-2");
  assert.equal(result.refresh, "rotated-account-2|desktop");
  assert.equal(result.expires, 1_000_000 + 3_600_000 - 300_000);
  assert.equal(result.profileArn, "arn:account-2");
  assert.equal(result.startUrl, "https://account-2.awsapps.com/start");
}

async function runIdcCheck() {
  const calls = [];
  const result = await refreshKiroCredential({
    access: "old-enterprise-2",
    refresh: "refresh-enterprise-2|client-2|secret-2|idc",
    expires: 0,
    authMethod: "idc",
    region: "ap-southeast-1",
    profileArn: "arn:enterprise-2",
    startUrl: "https://enterprise-2.awsapps.com/start",
    isEnterprise: true,
  }, {
    now: () => 2_000_000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        accessToken: "new-enterprise-2",
        refreshToken: "rotated-enterprise-2",
        expiresIn: 7200,
      }), { status: 200 });
    },
  });
  assert.equal(calls[0].url, "https://oidc.ap-southeast-1.amazonaws.com/token");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    clientId: "client-2",
    clientSecret: "secret-2",
    refreshToken: "refresh-enterprise-2",
    grantType: "refresh_token",
  });
  assert.equal(result.access, "new-enterprise-2");
  assert.equal(result.refresh, "rotated-enterprise-2|client-2|secret-2|idc");
  assert.equal(result.profileArn, "arn:enterprise-2");
  assert.equal(result.isEnterprise, true);
}

async function runInvalidCredentialChecks() {
  await assert.rejects(
    refreshKiroCredential({ access: "old", refresh: "token|unknown", authMethod: "unknown" }),
    /Log in again/,
  );
  await assert.rejects(
    refreshKiroCredential({ access: "old", refresh: "token|||idc", authMethod: "idc" }),
    /Log in again/,
  );
  await assert.rejects(
    refreshKiroCredential({ access: "old", authMethod: "desktop" }),
    /Log in again/,
  );
  await assert.rejects(
    refreshKiroCredential({ refresh: "token|desktop", authMethod: "desktop" }),
    /Log in again/,
  );
}

async function runKiroConfigCloneChecks() {
  const streamSimple = () => "kiro-stream";
  const unsafeRefresh = () => ({ access: "wrong-global-account" });
  const source = {
    baseUrl: "https://runtime.us-east-1.kiro.dev/",
    api: "kiro-api",
    apiKey: "$KIRO_API_KEY",
    models: [{
      id: "claude-sonnet",
      name: "Claude Sonnet",
      provider: "kiro",
      api: "kiro-api",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 32000,
      kiroModelId: "claude-sonnet-v1",
      requestFieldSchema: { temperature: true },
    }],
    async refreshModels() {
      return [{ ...this.models[0], id: "claude-refreshed" }];
    },
    oauth: {
      name: "Kiro",
      login: () => ({ access: "account-2" }),
      refreshToken: unsafeRefresh,
      getApiKey: (credential) => credential.access,
      getCliCredentials: () => ({ access: "wrong-global-account" }),
      modifyModels(models, credential) {
        assert.ok(models.every((model) => model.provider === "kiro"));
        return models.map((model) => ({
          ...model,
          baseUrl: `https://runtime.${credential.region}.kiro.dev/`,
          kiroRegion: credential.region,
          kiroProfileArn: credential.profileArn,
        }));
      },
    },
    streamSimple,
  };

  const localRefresh = (credential) => ({ ...credential, access: "refreshed-account-2" });
  const clone = cloneKiroProviderConfig(source, "kiro-2", 2, localRefresh);
  assert.equal(clone.streamSimple, streamSimple);
  assert.equal(clone.models[0].provider, "kiro-2");
  assert.equal(clone.models[0].kiroModelId, "claude-sonnet-v1");
  assert.deepEqual(clone.models[0].requestFieldSchema, { temperature: true });
  assert.equal(clone.oauth.login, source.oauth.login);
  assert.equal(clone.oauth.refreshToken, localRefresh);
  assert.equal("getCliCredentials" in clone.oauth, false);
  assert.equal("apiKey" in clone, false);

  const projected = clone.oauth.modifyModels(clone.models, {
    access: "account-2",
    region: "eu-central-1",
    profileArn: "arn:account-2",
  });
  assert.equal(projected[0].provider, "kiro-2");
  assert.equal(projected[0].kiroRegion, "eu-central-1");
  assert.equal(projected[0].kiroProfileArn, "arn:account-2");

  const refreshed = await clone.refreshModels({ credential: { access: "account-2" } });
  assert.equal(refreshed[0].provider, "kiro-2");
  assert.equal(refreshed[0].id, "claude-refreshed");
}

await runApiKeyCheck();
await runDesktopCheck();
await runIdcCheck();
await runInvalidCredentialChecks();
await runKiroConfigCloneChecks();
console.log("Kiro refresh checks passed");
