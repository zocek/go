/** @jest-environment node */
/* eslint-env jest, node */

// Tests for the Expo config plugin that generates the native notification
// texts (Android string/plurals resources, iOS .strings/.stringsdict and the
// Xcode project registration) from locales/<code>/notifications.json.
const fs = require("fs");
const os = require("os");
const path = require("path");

const { WarningAggregator } = require("expo/config-plugins");
const withNotificationLocales = require("../withNotificationLocales");

const {
  readNotificationLocales,
  getAndroidValuesDirName,
  buildAndroidStringsXml,
  buildIosStrings,
  buildIosStringsDict,
  writeAndroidResources,
  writeIosResources,
  addLocalesToXcodeProject,
} = withNotificationLocales;

// The real mod wrappers only run inside `expo prebuild`; record the registered
// mods on the config so the tests can run them directly.
jest.mock("expo/config-plugins", () => ({
  WarningAggregator: { addWarningIOS: jest.fn() },
  withDangerousMod: (config, [platform, action]) => ({
    ...config,
    mods: [...(config.mods || []), { platform, action }],
  }),
  withXcodeProject: (config, action) => ({
    ...config,
    mods: [...(config.mods || []), { platform: "ios", xcode: true, action }],
  }),
}));

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const REPO_LOCALES_DIR = path.join(REPO_ROOT, "locales");
const NSE_TARGET_NAME = "NotificationServiceExtension";
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];

const VALID_EN = {
  sent: "Sent",
  received: "Received",
  paymentHeld: "Payment Held:",
  sats_one: "sat",
  sats_other: "sats",
};
const VALID_CS = {
  sent: "Odesláno",
  received: "Přijato",
  paymentHeld: "Platba pozastavena:",
  sats_one: "sat",
  sats_few: "saty",
  sats_many: "satu",
  sats_other: "satů",
};

let tmpDirs = [];

function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
  WarningAggregator.addWarningIOS.mockClear();
});

// writes <dir>/<code>/notifications.json for every entry; strings are written
// verbatim (for invalid JSON), objects are serialized
function writeLocales(files) {
  const dir = makeTmpDir("notification-locales-");
  for (const [code, json] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, code), { recursive: true });
    fs.writeFileSync(
      path.join(dir, code, "notifications.json"),
      typeof json === "string" ? json : JSON.stringify(json, null, 2),
    );
  }
  return dir;
}

function withoutKey(json, key) {
  const copy = { ...json };
  delete copy[key];
  return copy;
}

function unquote(value) {
  const text = String(value);
  return text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
}

function parseAndroidStringsXml(xml) {
  const strings = {};
  for (const match of xml.matchAll(/<string name="([^"]+)">(.*?)<\/string>/g)) {
    strings[match[1]] = match[2];
  }
  const plurals = {};
  for (const match of xml.matchAll(/<item quantity="([^"]+)">(.*?)<\/item>/g)) {
    plurals[match[1]] = match[2];
  }
  return { strings, plurals };
}

function parseIosStrings(text) {
  const strings = {};
  for (const match of text.matchAll(/^"([^"]+)" = "((?:[^"\\]|\\.)*)";$/gm)) {
    strings[match[1]] = match[2];
  }
  return strings;
}

// key/string pairs of the innermost dict (the plural rule), category -> value
function parseIosStringsDictCategories(xml) {
  const categories = {};
  for (const match of xml.matchAll(
    /\t\t\t<key>(\w+)<\/key>\n\t\t\t<string>(.*?)<\/string>/g,
  )) {
    if (PLURAL_CATEGORIES.includes(match[1])) {
      categories[match[1]] = match[2];
    }
  }
  return categories;
}

function cldrPluralCategories(code) {
  return [...new Intl.PluralRules(code).resolvedOptions().pluralCategories];
}

const repoLocales = readNotificationLocales(REPO_LOCALES_DIR);
const repoCodes = repoLocales.map((locale) => locale.code);
const en = repoLocales.find((locale) => locale.code === "en");
const cs = repoLocales.find((locale) => locale.code === "cs");

describe("readNotificationLocales", () => {
  test("reads the repo locales with English first and the rest sorted", () => {
    expect(repoCodes[0]).toBe("en");
    expect(repoCodes).toContain("cs");
    expect(repoCodes.slice(1)).toEqual([...repoCodes.slice(1)].sort());
    expect(new Set(repoCodes).size).toBe(repoCodes.length);
  });

  test("maps the English keys to the native resource names", () => {
    expect(en).toEqual({
      code: "en",
      strings: {
        notification_sent: "Sent",
        notification_received: "Received",
        notification_payment_held: "Payment Held:",
      },
      plurals: { one: "sat", other: "sats" },
    });
  });

  test("reads the Czech plural forms", () => {
    expect(cs.strings).toEqual({
      notification_sent: "Odesláno",
      notification_received: "Přijato",
      notification_payment_held: "Platba pozastavena:",
    });
    expect(Object.keys(cs.plurals).sort()).toEqual(
      ["one", "few", "many", "other"].sort(),
    );
  });

  test("orders English first regardless of the directory order", () => {
    const dir = writeLocales({ cs: VALID_CS, de: VALID_EN, en: VALID_EN });
    expect(readNotificationLocales(dir).map((locale) => locale.code)).toEqual([
      "en",
      "cs",
      "de",
    ]);
  });

  test("skips directories without notifications.json", () => {
    const dir = writeLocales({ en: VALID_EN });
    fs.mkdirSync(path.join(dir, "native"));
    fs.writeFileSync(path.join(dir, "native", "cs.json"), "{}");
    fs.writeFileSync(path.join(dir, "index.ts"), "");
    expect(readNotificationLocales(dir).map((locale) => locale.code)).toEqual([
      "en",
    ]);
  });

  test("accepts every CLDR plural category", () => {
    const dir = writeLocales({
      en: {
        ...VALID_EN,
        sats_zero: "0",
        sats_two: "2",
        sats_few: "few",
        sats_many: "many",
      },
    });
    expect(Object.keys(readNotificationLocales(dir)[0].plurals).sort()).toEqual(
      [...PLURAL_CATEGORIES].sort(),
    );
  });

  test.each([
    [
      "missing English",
      { cs: VALID_CS },
      /^withNotificationLocales: locales\/en\/notifications\.json is required$/,
    ],
    [
      "unknown key",
      { en: { ...VALID_EN, foo: "bar" } },
      /locales\/en\/notifications\.json: unknown key "foo"/,
    ],
    [
      "unknown plural category",
      { en: { ...VALID_EN, sats_lots: "sats" } },
      /locales\/en\/notifications\.json: unknown key "sats_lots"/,
    ],
    [
      "plural with a different base key",
      { en: { ...VALID_EN, coins_one: "coin" } },
      /locales\/en\/notifications\.json: unknown key "coins_one"/,
    ],
    [
      "missing sats_other",
      { en: withoutKey(VALID_EN, "sats_other") },
      /locales\/en\/notifications\.json: missing key "sats_other"/,
    ],
    [
      "missing string key",
      { en: withoutKey(VALID_EN, "received") },
      /locales\/en\/notifications\.json: missing key "received"/,
    ],
    [
      "non-string value",
      { en: { ...VALID_EN, sent: 1 } },
      /locales\/en\/notifications\.json: "sent" must be a non-empty string/,
    ],
    [
      "empty string",
      { en: { ...VALID_EN, paymentHeld: "" } },
      /locales\/en\/notifications\.json: "paymentHeld" must be a non-empty string/,
    ],
    [
      "invalid JSON",
      { en: '{ "sent": ' },
      /^withNotificationLocales: locales\/en\/notifications\.json: /,
    ],
    [
      "error in a non-English file",
      { en: VALID_EN, cs: { ...VALID_CS, extra: "x" } },
      /locales\/cs\/notifications\.json: unknown key "extra"/,
    ],
  ])("rejects %s naming the file", (_name, files, message) => {
    const dir = writeLocales(files);
    expect(() => readNotificationLocales(dir)).toThrow(message);
  });
});

describe("getAndroidValuesDirName", () => {
  test.each([
    ["en", "values"],
    ["cs", "values-b+cs"],
    ["pt-BR", "values-b+pt+BR"],
    ["zh-Hans", "values-b+zh+Hans"],
  ])("%s -> %s", (code, dirName) => {
    expect(getAndroidValuesDirName(code)).toBe(dirName);
  });
});

describe("buildAndroidStringsXml", () => {
  test("generates the Czech strings and plurals", () => {
    const xml = buildAndroidStringsXml(cs);
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>\n')).toBe(
      true,
    );
    expect(xml).toContain(
      "<!-- Generated by plugins/withNotificationLocales.js from locales/cs/notifications.json. Do not edit. -->",
    );
    expect(xml).toContain(
      '  <string name="notification_sent">Odesláno</string>\n',
    );
    expect(xml).toContain(
      '  <string name="notification_received">Přijato</string>\n',
    );
    expect(xml).toContain(
      '  <string name="notification_payment_held">Platba pozastavena:</string>\n',
    );
    expect(xml).toContain(
      [
        '  <plurals name="notification_sats">',
        '    <item quantity="one">sat</item>',
        '    <item quantity="few">saty</item>',
        '    <item quantity="many">satu</item>',
        '    <item quantity="other">satů</item>',
        "  </plurals>",
        "</resources>",
        "",
      ].join("\n"),
    );
    expect(xml.endsWith("</resources>\n")).toBe(true);
    expect(parseAndroidStringsXml(xml)).toEqual({
      strings: cs.strings,
      plurals: cs.plurals,
    });
  });

  test("generates only one/other for English", () => {
    const { strings, plurals } = parseAndroidStringsXml(
      buildAndroidStringsXml(en),
    );
    expect(strings).toEqual(en.strings);
    expect(plurals).toEqual({ one: "sat", other: "sats" });
  });

  test("escapes Android string resources", () => {
    const xml = buildAndroidStringsXml({
      code: "xx",
      strings: {
        notification_sent: "it's",
        notification_received: 'say "hi" & <b>',
        notification_payment_held: "@ref?",
      },
      plurals: { one: "?one", other: "a\\b\nc > d" },
    });
    expect(parseAndroidStringsXml(xml)).toEqual({
      strings: {
        notification_sent: "it\\'s",
        notification_received: 'say \\"hi\\" &amp; &lt;b&gt;',
        notification_payment_held: "\\@ref?",
      },
      plurals: { one: "\\?one", other: "a\\\\b\\nc &gt; d" },
    });
    // every quote in a resource value is escaped; attribute quotes stay
    expect(xml).not.toMatch(/>[^<]*[^\\]'[^<]*</);
    expect(xml).not.toMatch(/>[^<]*[^\\]"[^<]*</);
  });
});

describe("buildIosStrings", () => {
  test("generates the Czech Localizable.strings", () => {
    const text = buildIosStrings(cs);
    expect(text.split("\n")[0]).toBe(
      "/* Generated by plugins/withNotificationLocales.js from locales/cs/notifications.json. Do not edit. */",
    );
    expect(text).toContain('"notification_sent" = "Odesláno";\n');
    expect(text).toContain('"notification_received" = "Přijato";\n');
    expect(text).toContain(
      '"notification_payment_held" = "Platba pozastavena:";\n',
    );
    expect(text.endsWith(";\n")).toBe(true);
    expect(parseIosStrings(text)).toEqual(cs.strings);
  });

  test("escapes quotes, backslashes and line breaks", () => {
    const text = buildIosStrings({
      code: "xx",
      strings: {
        notification_sent: 'say "hi"',
        notification_received: "a\\b\nc",
        notification_payment_held: "it's & <b> @?",
      },
      plurals: { other: "x" },
    });
    expect(text).toContain('"notification_sent" = "say \\"hi\\"";\n');
    expect(text).toContain('"notification_received" = "a\\\\b\\nc";\n');
    expect(text).toContain('"notification_payment_held" = "it\'s & <b> @?";\n');
    expect(Object.keys(parseIosStrings(text))).toHaveLength(3);
  });
});

describe("buildIosStringsDict", () => {
  test("generates the Czech plural rule", () => {
    const xml = buildIosStringsDict(cs);
    expect(xml.split("\n").slice(0, 2)).toEqual([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    ]);
    expect(xml).toContain(
      "<!-- Generated by plugins/withNotificationLocales.js from locales/cs/notifications.json. Do not edit. -->",
    );
    expect(xml).toContain("\t<key>notification_sats</key>\n\t<dict>\n");
    expect(xml).toContain(
      "\t\t<key>NSStringLocalizedFormatKey</key>\n\t\t<string>%#@sats@</string>\n\t\t<key>sats</key>\n\t\t<dict>\n",
    );
    expect(xml).toContain(
      "\t\t\t<key>NSStringFormatSpecTypeKey</key>\n\t\t\t<string>NSStringPluralRuleType</string>\n",
    );
    expect(xml).toContain(
      "\t\t\t<key>NSStringFormatValueTypeKey</key>\n\t\t\t<string>ld</string>\n",
    );
    expect(xml).toContain(
      [
        "\t\t\t<key>one</key>",
        "\t\t\t<string>sat</string>",
        "\t\t\t<key>few</key>",
        "\t\t\t<string>saty</string>",
        "\t\t\t<key>many</key>",
        "\t\t\t<string>satu</string>",
        "\t\t\t<key>other</key>",
        "\t\t\t<string>satů</string>",
        "\t\t</dict>",
        "\t</dict>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
    expect(parseIosStringsDictCategories(xml)).toEqual(cs.plurals);
    expect(xml.match(/<dict>/g)).toHaveLength(3);
    expect(xml.match(/<\/dict>/g)).toHaveLength(3);
  });

  test("generates only one/other for English", () => {
    const xml = buildIosStringsDict(en);
    expect(parseIosStringsDictCategories(xml)).toEqual({
      one: "sat",
      other: "sats",
    });
    for (const category of ["zero", "two", "few", "many"]) {
      expect(xml).not.toContain(`<key>${category}</key>`);
    }
  });

  test("escapes XML special characters only", () => {
    const xml = buildIosStringsDict({
      code: "xx",
      strings: en.strings,
      plurals: { one: 'a "b" & <c>', other: "it's\\n" },
    });
    expect(parseIosStringsDictCategories(xml)).toEqual({
      one: 'a "b" &amp; &lt;c&gt;',
      other: "it's\\n",
    });
  });
});

describe("plural categories", () => {
  test.each(repoCodes)(
    "%s provides exactly the CLDR plural categories",
    (code) => {
      const locale = repoLocales.find((entry) => entry.code === code);
      const expected = cldrPluralCategories(code).sort();
      expect(Object.keys(locale.plurals).sort()).toEqual(expected);
      expect(
        Object.keys(
          parseAndroidStringsXml(buildAndroidStringsXml(locale)).plurals,
        ).sort(),
      ).toEqual(expected);
      expect(
        Object.keys(
          parseIosStringsDictCategories(buildIosStringsDict(locale)),
        ).sort(),
      ).toEqual(expected);
    },
  );

  test("the generated plural items follow the CLDR category order", () => {
    const { plurals } = parseAndroidStringsXml(buildAndroidStringsXml(cs));
    expect(Object.keys(plurals)).toEqual(["one", "few", "many", "other"]);
  });
});

describe("writeAndroidResources / writeIosResources", () => {
  test("writes one strings_notifications.xml per values directory", () => {
    const resDir = makeTmpDir("notification-res-");
    const written = writeAndroidResources(resDir, repoLocales);
    expect(written).toEqual(
      repoLocales.map((locale) =>
        path.join(
          resDir,
          getAndroidValuesDirName(locale.code),
          "strings_notifications.xml",
        ),
      ),
    );
    expect(
      fs.readFileSync(
        path.join(resDir, "values", "strings_notifications.xml"),
        "utf8",
      ),
    ).toBe(buildAndroidStringsXml(en));
    expect(
      fs.readFileSync(
        path.join(resDir, "values-b+cs", "strings_notifications.xml"),
        "utf8",
      ),
    ).toBe(buildAndroidStringsXml(cs));
  });

  test("writes Localizable.strings and .stringsdict per lproj directory", () => {
    const nseDir = makeTmpDir("notification-nse-");
    const written = writeIosResources(nseDir, repoLocales);
    expect(written).toEqual(
      repoLocales.flatMap((locale) => [
        path.join(nseDir, `${locale.code}.lproj`, "Localizable.strings"),
        path.join(nseDir, `${locale.code}.lproj`, "Localizable.stringsdict"),
      ]),
    );
    expect(
      fs.readFileSync(
        path.join(nseDir, "cs.lproj", "Localizable.strings"),
        "utf8",
      ),
    ).toBe(buildIosStrings(cs));
    expect(
      fs.readFileSync(
        path.join(nseDir, "en.lproj", "Localizable.stringsdict"),
        "utf8",
      ),
    ).toBe(buildIosStringsDict(en));
  });
});

describe("withNotificationLocales", () => {
  test("registers the android and ios dangerous mods and the Xcode mod", () => {
    const config = withNotificationLocales({ name: "app" });
    expect(config.name).toBe("app");
    expect(
      config.mods.map((mod) => (mod.xcode ? "xcodeproj" : mod.platform)),
    ).toEqual(["android", "ios", "xcodeproj"]);
  });

  test("the android mod writes the resources into the native project", async () => {
    const platformProjectRoot = makeTmpDir("notification-android-");
    const config = withNotificationLocales({});
    const mod = config.mods.find((entry) => entry.platform === "android");
    const result = await mod.action({
      ...config,
      modRequest: { projectRoot: REPO_ROOT, platformProjectRoot },
    });
    expect(result.modRequest.platformProjectRoot).toBe(platformProjectRoot);
    const resDir = path.join(platformProjectRoot, "app", "src", "main", "res");
    expect(
      fs.readFileSync(
        path.join(resDir, "values-b+cs", "strings_notifications.xml"),
        "utf8",
      ),
    ).toBe(buildAndroidStringsXml(cs));
    expect(
      fs.existsSync(path.join(resDir, "values", "strings_notifications.xml")),
    ).toBe(true);
  });

  test("the ios mod writes the lproj directories into the extension", async () => {
    const platformProjectRoot = makeTmpDir("notification-ios-");
    const config = withNotificationLocales({});
    const mod = config.mods.find(
      (entry) => entry.platform === "ios" && !entry.xcode,
    );
    await mod.action({
      ...config,
      modRequest: { projectRoot: REPO_ROOT, platformProjectRoot },
    });
    const nseDir = path.join(platformProjectRoot, NSE_TARGET_NAME);
    expect(
      fs.readFileSync(
        path.join(nseDir, "cs.lproj", "Localizable.stringsdict"),
        "utf8",
      ),
    ).toBe(buildIosStringsDict(cs));
    expect(
      fs.existsSync(path.join(nseDir, "en.lproj", "Localizable.strings")),
    ).toBe(true);
  });
});

// The Xcode project step is tested against a real .pbxproj shipped with a
// dependency (parsed by the `xcode` package @expo/config-plugins uses); the
// NotificationServiceExtension target is added the same way
// expo-notification-service-extension-plugin does it. Skipped when neither is
// available instead of failing.
const PBXPROJ_FIXTURES = [
  "@sentry/react-native/ios/RNSentry.xcodeproj/project.pbxproj",
  "react-native-safe-area-context/ios/RNSafeAreaContext.xcodeproj/project.pbxproj",
  "react-native-screens/ios/RNScreens.xcodeproj/project.pbxproj",
  "react-native-webview/ios/RNCWebView.xcodeproj/project.pbxproj",
];

function findPbxprojFixture() {
  return PBXPROJ_FIXTURES.map((fixture) =>
    path.join(REPO_ROOT, "node_modules", fixture),
  ).find((fixture) => fs.existsSync(fixture));
}

function loadXcodePackage() {
  try {
    return require("xcode");
  } catch {
    return null;
  }
}

const pbxprojFixture = findPbxprojFixture();
const xcode = loadXcodePackage();
const describeXcode = pbxprojFixture && xcode ? describe : describe.skip;

describeXcode("addLocalesToXcodeProject", () => {
  function loadFixtureProject() {
    const project = xcode.project(pbxprojFixture);
    project.parseSync();
    return project;
  }

  // mirrors withOneSignalXcodeProject in expo-notification-service-extension-plugin
  function addNseTarget(project, { withResourcesPhase = true } = {}) {
    const group = project.addPbxGroup(
      ["NotificationService.m"],
      NSE_TARGET_NAME,
      NSE_TARGET_NAME,
    );
    const groups = project.hash.project.objects.PBXGroup;
    for (const key of Object.keys(groups)) {
      const candidate = groups[key];
      if (
        typeof candidate === "object" &&
        candidate.name === undefined &&
        candidate.path === undefined
      ) {
        project.addToPbxGroup(group.uuid, key);
      }
    }
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency = objects.PBXTargetDependency || {};
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};
    const target = project.addTarget(
      NSE_TARGET_NAME,
      "app_extension",
      NSE_TARGET_NAME,
      `com.example.app.${NSE_TARGET_NAME}`,
    );
    project.addBuildPhase(
      ["NotificationService.m"],
      "PBXSourcesBuildPhase",
      "Sources",
      target.uuid,
    );
    if (withResourcesPhase) {
      project.addBuildPhase(
        [],
        "PBXResourcesBuildPhase",
        "Resources",
        target.uuid,
      );
    }
    project.addBuildPhase(
      [],
      "PBXFrameworksBuildPhase",
      "Frameworks",
      target.uuid,
    );
    return { project, targetUuid: target.uuid, groupKey: group.uuid };
  }

  function entries(section) {
    return Object.entries(section || {}).filter(
      ([key]) => !key.endsWith("_comment"),
    );
  }

  function variantGroups(project) {
    return Object.fromEntries(
      entries(project.hash.project.objects.PBXVariantGroup).map(
        ([key, group]) => [unquote(group.name), { key, group }],
      ),
    );
  }

  function lprojFileReferences(project) {
    return entries(project.pbxFileReferenceSection())
      .map(([, file]) => file)
      .filter((file) => /\.lproj\//.test(unquote(file.path)));
  }

  function knownRegions(project) {
    return project.pbxProjectSection()[project.getFirstProject().uuid]
      .knownRegions;
  }

  test("returns false and warns when the extension target is missing", () => {
    const project = loadFixtureProject();
    const before = project.writeSync();
    expect(addLocalesToXcodeProject(project, repoLocales)).toBe(false);
    expect(WarningAggregator.addWarningIOS).toHaveBeenCalledTimes(1);
    expect(WarningAggregator.addWarningIOS).toHaveBeenCalledWith(
      "withNotificationLocales",
      expect.stringContaining(`"${NSE_TARGET_NAME}" not found`),
    );
    expect(project.writeSync()).toBe(before);
  });

  test("registers the lproj files in the extension group and Resources phase", () => {
    const { project, targetUuid, groupKey } =
      addNseTarget(loadFixtureProject());
    const before = project.writeSync();

    expect(addLocalesToXcodeProject(project, repoLocales)).toBe(true);
    expect(WarningAggregator.addWarningIOS).not.toHaveBeenCalled();

    const groups = variantGroups(project);
    expect(Object.keys(groups).sort()).toEqual([
      "Localizable.strings",
      "Localizable.stringsdict",
    ]);
    const fileReferences = project.pbxFileReferenceSection();
    for (const [fileName, fileType] of [
      ["Localizable.strings", "text.plist.strings"],
      ["Localizable.stringsdict", "text.plist.stringsdict"],
    ]) {
      const { key, group } = groups[fileName];
      expect(unquote(group.isa)).toBe("PBXVariantGroup");
      expect(group.children.map((child) => child.comment)).toEqual(repoCodes);
      for (const child of group.children) {
        const file = fileReferences[child.value];
        expect(unquote(file.path)).toBe(`${child.comment}.lproj/${fileName}`);
        expect(file.lastKnownFileType).toBe(fileType);
        expect(unquote(file.sourceTree)).toBe("<group>");
        expect(Object.values(file)).not.toContain(undefined);
      }
      // listed in the NotificationServiceExtension group
      expect(
        project.hash.project.objects.PBXGroup[groupKey].children,
      ).toContainEqual({ value: key, comment: fileName });
      // compiled into the extension via its Resources phase
      const phase = project.pbxResourcesBuildPhaseObj(targetUuid);
      const buildFiles = project.pbxBuildFileSection();
      expect(
        phase.files.filter((entry) => buildFiles[entry.value].fileRef === key),
      ).toHaveLength(1);
    }
    expect(lprojFileReferences(project)).toHaveLength(2 * repoCodes.length);
    for (const code of repoCodes) {
      expect(knownRegions(project)).toContain(code);
    }

    // the xcode writer prints `undefined` for keys without a value; none of
    // the objects added by the plugin may have one
    const beforeLines = new Set(before.split("\n"));
    const addedLines = project
      .writeSync()
      .split("\n")
      .filter((line) => !beforeLines.has(line));
    expect(addedLines.length).toBeGreaterThan(0);
    expect(addedLines.filter((line) => line.includes("undefined"))).toEqual([]);
    expect(addedLines.join("\n")).toContain("cs.lproj/Localizable.stringsdict");
  });

  test("is idempotent", () => {
    const { project, targetUuid } = addNseTarget(loadFixtureProject());
    expect(addLocalesToXcodeProject(project, repoLocales)).toBe(true);
    const once = project.writeSync();
    expect(addLocalesToXcodeProject(project, repoLocales)).toBe(true);
    expect(project.writeSync()).toBe(once);
    expect(Object.keys(variantGroups(project))).toHaveLength(2);
    expect(lprojFileReferences(project)).toHaveLength(2 * repoCodes.length);
    expect(project.pbxResourcesBuildPhaseObj(targetUuid).files).toHaveLength(2);
    const regions = knownRegions(project);
    expect(new Set(regions).size).toBe(regions.length);
  });

  test("adds a new language to the existing variant groups", () => {
    const { project, targetUuid } = addNseTarget(loadFixtureProject());
    addLocalesToXcodeProject(project, repoLocales);
    const stringsGroupKey = variantGroups(project)["Localizable.strings"].key;
    const existingChildren = [
      ...variantGroups(project)["Localizable.strings"].group.children,
    ];

    const withPtBr = [
      ...repoLocales,
      { code: "pt-BR", strings: en.strings, plurals: en.plurals },
    ];
    expect(addLocalesToXcodeProject(project, withPtBr)).toBe(true);

    const groups = variantGroups(project);
    expect(Object.keys(groups)).toHaveLength(2);
    expect(groups["Localizable.strings"].key).toBe(stringsGroupKey);
    expect(groups["Localizable.strings"].group.children.slice(0, -1)).toEqual(
      existingChildren,
    );
    expect(
      groups["Localizable.stringsdict"].group.children.map(
        (child) => child.comment,
      ),
    ).toEqual([...repoCodes, "pt-BR"]);
    const added = lprojFileReferences(project).filter((file) =>
      unquote(file.path).startsWith("pt-BR.lproj/"),
    );
    expect(added).toHaveLength(2);
    expect(project.pbxResourcesBuildPhaseObj(targetUuid).files).toHaveLength(2);
    // region names with a hyphen must be quoted in the pbxproj
    expect(knownRegions(project)).toContain('"pt-BR"');
    expect(project.writeSync()).toContain("pt-BR.lproj/Localizable.strings");
  });

  test("creates the Resources build phase when the target has none", () => {
    const { project, targetUuid } = addNseTarget(loadFixtureProject(), {
      withResourcesPhase: false,
    });
    expect(project.pbxResourcesBuildPhaseObj(targetUuid)).toBeFalsy();
    expect(addLocalesToXcodeProject(project, repoLocales)).toBe(true);
    expect(project.pbxResourcesBuildPhaseObj(targetUuid).files).toHaveLength(2);
  });

  test("the Xcode mod of the plugin applies the registration", async () => {
    const { project } = addNseTarget(loadFixtureProject());
    const config = withNotificationLocales({});
    const mod = config.mods.find((entry) => entry.xcode);
    const result = await mod.action({
      ...config,
      modRequest: { projectRoot: REPO_ROOT },
      modResults: project,
    });
    expect(result.modResults).toBe(project);
    expect(Object.keys(variantGroups(project)).sort()).toEqual([
      "Localizable.strings",
      "Localizable.stringsdict",
    ]);
  });
});
