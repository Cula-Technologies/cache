import * as core from "@actions/core";

import { Events, Inputs, RefKey } from "../src/constants";
import { saveImpl } from "../src/saveImpl";
import { StateProvider } from "../src/stateProvider";
import * as actionUtils from "../src/utils/actionUtils";
import * as cache from "../src/utils/gcsCache";
import * as testUtils from "../src/utils/testUtils";

jest.mock("@actions/core");
jest.mock("@actions/cache");
jest.mock("../src/utils/actionUtils");

// The post step reads several states; key the mock by state name so a new
// read cannot shift which value the others receive.
function mockState(states: Record<string, string>): void {
    jest.spyOn(core, "getState").mockImplementation(
        (name: string) => states[name] ?? ""
    );
}

beforeAll(() => {
    jest.spyOn(core, "getInput").mockImplementation((name, options) => {
        return jest.requireActual("@actions/core").getInput(name, options);
    });

    jest.spyOn(actionUtils, "getInputAsArray").mockImplementation(
        (name, options) => {
            return jest
                .requireActual("../src/utils/actionUtils")
                .getInputAsArray(name, options);
        }
    );

    jest.spyOn(actionUtils, "getInputAsInt").mockImplementation(
        (name, options) => {
            return jest
                .requireActual("../src/utils/actionUtils")
                .getInputAsInt(name, options);
        }
    );

    jest.spyOn(actionUtils, "getInputAsBool").mockImplementation(
        (name, options) => {
            return jest
                .requireActual("../src/utils/actionUtils")
                .getInputAsBool(name, options);
        }
    );

    jest.spyOn(actionUtils, "isExactKeyMatch").mockImplementation(
        (key, cacheResult) => {
            return jest
                .requireActual("../src/utils/actionUtils")
                .isExactKeyMatch(key, cacheResult);
        }
    );

    jest.spyOn(actionUtils, "isValidEvent").mockImplementation(() => {
        const actualUtils = jest.requireActual("../src/utils/actionUtils");
        return actualUtils.isValidEvent();
    });
});

beforeEach(() => {
    jest.restoreAllMocks();
    process.env[Events.Key] = Events.Push;
    process.env[RefKey] = "refs/heads/feature-branch";

    jest.spyOn(actionUtils, "isGhes").mockImplementation(() => false);
    jest.spyOn(actionUtils, "isCacheFeatureAvailable").mockImplementation(
        () => true
    );
});

afterEach(() => {
    testUtils.clearInputs();
    delete process.env[Events.Key];
    delete process.env[RefKey];
});

test("save with invalid event outputs warning", async () => {
    const logWarningMock = jest.spyOn(actionUtils, "logWarning");
    const failedMock = jest.spyOn(core, "setFailed");
    const invalidEvent = "commit_comment";
    process.env[Events.Key] = invalidEvent;
    delete process.env[RefKey];
    await saveImpl(new StateProvider());
    expect(logWarningMock).toHaveBeenCalledWith(
        `Event Validation Error: The event type ${invalidEvent} is not supported because it's not tied to a branch or tag ref.`
    );
    expect(failedMock).toHaveBeenCalledTimes(0);
});

test("save with no primary key in state outputs warning", async () => {
    const logWarningMock = jest.spyOn(actionUtils, "logWarning");
    const failedMock = jest.spyOn(core, "setFailed");

    const savedCacheKey = "Linux-node-bb828da54c148048dd17899ba9fda624811cfb43";
    mockState({ CACHE_KEY: "", CACHE_RESULT: savedCacheKey });
    const saveCacheMock = jest.spyOn(cache, "saveCache");

    await saveImpl(new StateProvider());

    expect(saveCacheMock).toHaveBeenCalledTimes(0);
    expect(logWarningMock).toHaveBeenCalledWith(`Key is not specified.`);
    expect(logWarningMock).toHaveBeenCalledTimes(1);
    expect(failedMock).toHaveBeenCalledTimes(0);
});

test("save without AC available should no-op", async () => {
    jest.spyOn(actionUtils, "isCacheFeatureAvailable").mockImplementation(
        () => false
    );

    const saveCacheMock = jest.spyOn(cache, "saveCache");

    await saveImpl(new StateProvider());

    expect(saveCacheMock).toHaveBeenCalledTimes(0);
});

test("save on ghes without AC available should no-op", async () => {
    jest.spyOn(actionUtils, "isGhes").mockImplementation(() => true);
    jest.spyOn(actionUtils, "isCacheFeatureAvailable").mockImplementation(
        () => false
    );

    const saveCacheMock = jest.spyOn(cache, "saveCache");

    await saveImpl(new StateProvider());

    expect(saveCacheMock).toHaveBeenCalledTimes(0);
});

test("save on GHES with AC available", async () => {
    jest.spyOn(actionUtils, "isGhes").mockImplementation(() => true);
    const failedMock = jest.spyOn(core, "setFailed");

    const primaryKey = "Linux-node-bb828da54c148048dd17899ba9fda624811cfb43";
    const savedCacheKey = "Linux-node-";

    mockState({ CACHE_KEY: primaryKey, CACHE_RESULT: savedCacheKey });

    const inputPath = "node_modules";
    testUtils.setInput(Inputs.Path, inputPath);
    testUtils.setInput(Inputs.UploadChunkSize, "4000000");

    const cacheId = 4;
    const saveCacheMock = jest
        .spyOn(cache, "saveCache")
        .mockImplementationOnce(() => {
            return Promise.resolve(cacheId);
        });

    await saveImpl(new StateProvider());

    expect(saveCacheMock).toHaveBeenCalledTimes(1);
    expect(saveCacheMock).toHaveBeenCalledWith([inputPath], primaryKey);

    expect(failedMock).toHaveBeenCalledTimes(0);
});

test("save with exact match returns early", async () => {
    const infoMock = jest.spyOn(core, "info");
    const failedMock = jest.spyOn(core, "setFailed");

    const primaryKey = "Linux-node-bb828da54c148048dd17899ba9fda624811cfb43";
    const savedCacheKey = primaryKey;

    mockState({ CACHE_KEY: primaryKey, CACHE_RESULT: savedCacheKey });
    const saveCacheMock = jest.spyOn(cache, "saveCache");

    await saveImpl(new StateProvider());

    expect(saveCacheMock).toHaveBeenCalledTimes(0);
    expect(infoMock).toHaveBeenCalledWith(
        `Cache hit occurred on the primary key ${primaryKey}, not saving cache.`
    );
    expect(failedMock).toHaveBeenCalledTimes(0);
});

test("save with missing input outputs warning", async () => {
    const logWarningMock = jest.spyOn(actionUtils, "logWarning");
    const failedMock = jest.spyOn(core, "setFailed");

    const primaryKey = "Linux-node-bb828da54c148048dd17899ba9fda624811cfb43";
    const savedCacheKey = "Linux-node-";

    mockState({ CACHE_KEY: primaryKey, CACHE_RESULT: savedCacheKey });
    const saveCacheMock = jest.spyOn(cache, "saveCache");

    await saveImpl(new StateProvider());

    expect(saveCacheMock).toHaveBeenCalledTimes(0);
    expect(logWarningMock).toHaveBeenCalledWith(
        "Input required and not supplied: path"
    );
    expect(logWarningMock).toHaveBeenCalledTimes(1);
    expect(failedMock).toHaveBeenCalledTimes(0);
});

test("save with valid inputs uploads a cache", async () => {
    const failedMock = jest.spyOn(core, "setFailed");

    const primaryKey = "Linux-node-bb828da54c148048dd17899ba9fda624811cfb43";
    const savedCacheKey = "Linux-node-";

    mockState({ CACHE_KEY: primaryKey, CACHE_RESULT: savedCacheKey });

    const inputPath = "node_modules";
    testUtils.setInput(Inputs.Path, inputPath);
    testUtils.setInput(Inputs.UploadChunkSize, "4000000");

    const cacheId = 4;
    const saveCacheMock = jest
        .spyOn(cache, "saveCache")
        .mockImplementationOnce(() => {
            return Promise.resolve(cacheId);
        });

    await saveImpl(new StateProvider());

    expect(saveCacheMock).toHaveBeenCalledTimes(1);
    expect(saveCacheMock).toHaveBeenCalledWith([inputPath], primaryKey);

    expect(failedMock).toHaveBeenCalledTimes(0);
});

test("save with exact match restored from GCS returns early", async () => {
    const infoMock = jest.spyOn(core, "info");
    jest.spyOn(actionUtils, "isGCSAvailable").mockImplementation(() => true);

    const primaryKey = "Linux-node-bb828da54c148048dd17899ba9fda624811cfb43";
    mockState({
        CACHE_KEY: primaryKey,
        CACHE_RESULT: primaryKey,
        CACHE_SOURCE: "gcs"
    });
    testUtils.setInput(Inputs.Path, "node_modules");
    const gcsSaveMock = jest.spyOn(cache, "saveCache");

    await saveImpl(new StateProvider());

    expect(gcsSaveMock).toHaveBeenCalledTimes(0);
    expect(infoMock).toHaveBeenCalledWith(
        `Cache hit occurred on the primary key ${primaryKey}, not saving cache.`
    );
});

test("save with empty path input uses the paths recorded by restore", async () => {
    const primaryKey = "Linux-node-bb828da54c148048dd17899ba9fda624811cfb43";
    mockState({
        CACHE_KEY: primaryKey,
        CACHE_RESULT: "Linux-node-",
        CACHE_PATHS: "node_modules\n~/.cache/Cypress"
    });
    testUtils.setInput(Inputs.UploadChunkSize, "4000000");
    const saveCacheMock = jest
        .spyOn(cache, "saveCache")
        .mockImplementationOnce(() => Promise.resolve(4));

    await saveImpl(new StateProvider());

    expect(saveCacheMock).toHaveBeenCalledTimes(1);
    expect(saveCacheMock).toHaveBeenCalledWith(
        ["node_modules", "~/.cache/Cypress"],
        primaryKey
    );
});
