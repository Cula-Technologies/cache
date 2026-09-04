import { Storage } from "@google-cloud/storage";

import * as actionUtils from "../src/utils/actionUtils";
import { saveCache } from "../src/utils/gcsCache";

jest.mock("@actions/cache");
jest.mock("@google-cloud/storage");
jest.mock("../src/utils/actionUtils");
jest.mock("@actions/cache/lib/internal/cacheUtils", () => ({
    getCompressionMethod: jest.fn().mockResolvedValue("zstd"),
    getCacheFileName: jest.fn().mockReturnValue("cache.tzst"),
    createTempDirectory: jest.fn().mockResolvedValue("/tmp/gcs-cache-test"),
    getArchiveFileSizeInBytes: jest.fn().mockReturnValue(1024),
    unlinkFile: jest.fn().mockResolvedValue(undefined),
    resolvePaths: jest.fn().mockResolvedValue(["some/path"])
}));

const createTar = jest.fn();
jest.mock("@actions/cache/lib/internal/tar", () => ({
    createTar: (...args: unknown[]) => createTar(...args),
    extractTar: jest.fn(),
    listTar: jest.fn()
}));

const BUCKET = "test-bucket";
const KEY = "Linux-modules-abc123";
// getGCSPath's shape: <prefix>/<key>.<compression extension>
const OBJECT = "github-cache/Linux-modules-abc123.cache.tzst";

let upload: jest.Mock;

function mockStorage(existingObjects: string[]): void {
    upload = jest.fn().mockResolvedValue([{ metadata: { id: "uploaded" } }]);
    const bucketApi = {
        file: (path: string) => ({
            exists: jest
                .fn()
                .mockResolvedValue([existingObjects.includes(path)])
        }),
        upload
    };
    (Storage as unknown as jest.Mock).mockImplementation(() => ({
        bucket: () => bucketApi
    }));
}

beforeEach(() => {
    // Clear call history, then (re)establish implementations. NOT
    // resetAllMocks: that wipes the module-mock implementations set here and
    // leaves isGCSAvailable() falsy for every test after the first.
    jest.clearAllMocks();
    jest.mocked(actionUtils.isGCSAvailable).mockReturnValue(true);
    jest.mocked(actionUtils.getGCSBucket).mockReturnValue(BUCKET);
});

test("a key the bucket already holds is not re-uploaded", async () => {
    mockStorage([OBJECT]);

    await expect(saveCache(["some/path"], KEY)).resolves.toBe(1);

    expect(upload).not.toHaveBeenCalled();
    // The point is not only the transfer saved: the tar is skipped too, which
    // is the expensive half for a large cache.
    expect(createTar).not.toHaveBeenCalled();
});

test("a key the bucket does not hold is uploaded", async () => {
    mockStorage([]);

    await expect(saveCache(["some/path"], KEY)).resolves.toBe(1);

    expect(createTar).toHaveBeenCalled();
    expect(upload).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ destination: OBJECT })
    );
});
