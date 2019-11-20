import winston from "winston";
import puppeteer from "puppeteer";
import { eachLimit } from "async";

const DEBUG = process.env.NODE_ENV !== "production";
const LOGLEVEL = process.env.LOGLEVEL || (DEBUG ? "debug" : "info");
const DNDTOOLS_URL_BASE = "https://dndtools.net";
//const DNDTOOLS_URL_BASE = "http://localhost:32769";
const RULEBOOKS = [
    "Player's Handbook v.3.5",
    "Spell Compendium"
];
const CONCURRENCY = 4;
const RETRY_LIMIT = 10;

const logger = winston.createLogger({
    level: LOGLEVEL,
    transports: [
        new winston.transports.Console({
            stderrLevels: ["error", "warn", "info", "verbose", "debug", "silly"]
        })
    ]
});

type ClassSpellLevel = {
    class: string;
    level: number;
};

type DomainSpellLevel = {
    domain: string;
    level: number;
};

type SpellSource = {
    rulebook: string;
    page: number;
};

type Spell = {
    id: string;
    name: string;
    source: SpellSource | null;
    description: string | null;
    classLevels: ClassSpellLevel[];
    domainLevels: DomainSpellLevel[];
    schools: string[];
    subschools: string[];
    descriptors: string[];
    components: string[];
    castingTime: string | null;
    range: string | null;
    area: string | null;
    target: string | null;
    effect: string | null;
    duration: string | null;
    savingThrow: string | null;
    spellResistance: string | null;
};

async function crawlSpellListPage(page: puppeteer.Page) {
    logger.debug("Entering crawlSpellListPage()");

    const rows = await page.$$("table.common tr");
    const spellUrls = [];

    for (const row of rows) {
        try {
            const isHeader = await row.$("th") !== null;
            if (isHeader) {
                continue;
            }

            const rulebook = await row.$eval("td:nth-child(4) a", e => e.textContent);
            if (RULEBOOKS.includes(rulebook)) {
                const spellUrl = await row.$eval("td:nth-child(1) a", e => e.getAttribute("href"));
                spellUrls.push(spellUrl);
            }
        } catch (error) {
            logger.warn("Error parsing spell table row.", {error:error.message});
        }
    }

    logger.debug(`crawlSpellListPage() found ${spellUrls.length} spells.`);

    return spellUrls;
}

async function crawlSpellListPages(browser: puppeteer.Browser) {
    // Look through all spell list pages and add spell urls to the queue

    const spellUrls = [];

    const page = await browser.newPage();
    try {
        await page.goto(`${DNDTOOLS_URL_BASE}/spells/?page_size=1000`);
        while (true) {
            const newSpellUrls = await crawlSpellListPage(page);
            spellUrls.push(...newSpellUrls);

            const nextBtn = await page.$("a.next");

            if (nextBtn != null) {
                logger.verbose("Navigating to next spells page.");

                // Might not work, se try again!
                while (true) {
                    try {
                        await Promise.all([
                            page.waitForNavigation(),
                            nextBtn.click()
                        ]);

                        break;
                    } catch (error) {
                        logger.warn("Navigation to next page failed, retrying.", {error: error.message});
                    }
                }
            } else {
                logger.verbose("No more spells pages, closing tab.");
                break;
            }
        }
    } finally {
        if (page != null) {
            page.close();
        }
    }

    return spellUrls;
}

async function crawlSpellPage(browser: puppeteer.Browser, url: string) {
    const spellLogger = logger.child({url});
    spellLogger.verbose("Reading spell");

    function parseClassSpellLevel(str: string) {
        const r = /^(.*)\s(\d+)$/.exec(str);
    
        let spellLevel: ClassSpellLevel = null;
    
        if (r != null) {
            spellLevel = {
                class: r[1],
                level: parseInt(r[2])
            };
        }
    
        return spellLevel;
    }

    async function readSpellProperty<T>(page: puppeteer.Page, propertyName: string, readFn: (p: puppeteer.Page) => Promise<T>, defaultValue: T): Promise<T> {
        try {
            const v = await readFn(page);
            spellLogger.debug(`Read ${propertyName}.`, {[propertyName]: v});
            return v;
        } catch (error) {
            spellLogger.warn(`Could not read spell ${propertyName}.`, {error: error.message});
            return defaultValue;
        }
    }
    
    async function readName(page: puppeteer.Page) {
        try {
            const name = await page.$eval("#content h2", e => e.textContent.trim());
            spellLogger.debug("Read name.", {name});
            return name;
        } catch (error) {
            throw error;
        }
    }

    async function readSource(page: puppeteer.Page) {
        try {
            const source: SpellSource = await page.$eval("#content a[href^=\"/rulebooks/\"]", e => ({
                rulebook: e.textContent.trim(),
                page: parseInt(/\d+/.exec(e.nextSibling.textContent)[0])
            }));
            spellLogger.debug("Read source.", {source});
            return source;
        } catch (error) {
            spellLogger.warn("Could not read spell source.", {error: error.message});
            return null;
        }
    }

    async function readSchools(page: puppeteer.Page) {
        try {
            const schools = await page.$$eval("#content a[href^=\"/spells/schools/\"]", el => el.map(e => e.textContent.trim()));
            spellLogger.debug("Read schools.", {schools});
            return schools;
        } catch (error) {
            spellLogger.warn("Could not read spell schools.", {error: error.message});
            return [];
        }
    }

    async function readSubschools(page: puppeteer.Page) {
        try {
            const subschools = await page.$$eval("#content a[href^=\"/spells/sub-schools/\"]", el => el.map(e => e.textContent.trim()));
            spellLogger.debug("Read subschools.", {subschools});
            return subschools;
        } catch (error) {
            spellLogger.warn("Could not read spell subschools.", {error: error.message});
            return [];
        }
    }

    async function readDescriptors(page: puppeteer.Page) {
        try {
            const descriptors = await page.$$eval("#content a[href^=\"/spells/descriptors/\"]", el => el.map(e => e.textContent.trim()));
            spellLogger.debug("Read descriptors.", {descriptors});
            return descriptors;
        } catch (error) {
            spellLogger.warn("Could not read spell descriptors.", {error: error.message});
            return [];
        }
    }

    async function readClassLevels(page: puppeteer.Page) {
        try {
            const classLevels = (await page.$$eval("#content a[href^=\"/classes/\"]", el => el.map(e => e.textContent))).map(parseClassSpellLevel);
            spellLogger.debug("Read classLevels.", {classLevels});
            return classLevels;
        } catch (error) {
            spellLogger.warn("Could not read spell classLevels.", {error: error.message});
            return [];
        }
    }

    async function readDomainLevels(page: puppeteer.Page) {
        try {
            const domainNameElements = await page.$$("#content a[href^=\"/spells/domains/\"]");

            const domainLevels: DomainSpellLevel[] = await Promise.all(domainNameElements.map(async e => {
                const domainSpellLevel: DomainSpellLevel = {
                    domain: await e.evaluate(e => e.textContent),
                    level: await e.evaluate(e => parseInt(e.nextSibling.textContent))
                };

                return domainSpellLevel;
            }));

            spellLogger.debug("Read domainLevels.", {domainLevels});
            return domainLevels;
        } catch (error) {
            spellLogger.warn("Could not read spell domainLevels.", {error: error.message});
            return [];
        }
    }

    async function readComponents(page: puppeteer.Page) {
        try {
            const components = await Promise.all((await page.$x("//strong[text()=\"Components:\"]/following-sibling::abbr")).map(eh => eh.evaluate(e => e.getAttribute("title"))));
            spellLogger.debug("Read components.", {components});
            return components;
        } catch (error) {
            spellLogger.warn("Could not read spell components.", {error: error.message});
            return [];
        }
    }

    async function readCastingTime(page: puppeteer.Page) {
        try {
            const castingTime = await (await page.$x("//strong[text()=\"Casting Time:\"]/following-sibling::text()[1]"))[0].evaluate(e => e.textContent.trim());
            spellLogger.debug("Read castingTime.", {castingTime});
            return castingTime;
        } catch (error) {
            spellLogger.warn("Could not read spell castingTime.", {error: error.message});
            return null;
        }
    }

    async function readRange(page: puppeteer.Page) {
        try {
            const range = await (await page.$x("//strong[text()=\"Range:\"]/following-sibling::text()[1]"))[0].evaluate(e => e.textContent.trim());
            spellLogger.debug("Read range.", {range});
            return range;
        } catch (error) {
            spellLogger.warn("Could not read spell range.", {error: error.message});
            return null;
        }
    }

    async function readArea(page: puppeteer.Page) {
        try {
            const area = await (await page.$x("//strong[text()=\"Area:\"]/following-sibling::text()[1]"))[0].evaluate(e => e.textContent.trim());
            spellLogger.debug("Read range.", {area});
            return area;
        } catch (error) {
            spellLogger.warn("Could not read spell area.", {error: error.message});
            return null;
        }
    }

    async function readTarget(page: puppeteer.Page) {
        try {
            const target = await (await page.$x("//strong[text()=\"Target:\"]/following-sibling::text()[1]"))[0].evaluate(e => e.textContent.trim());
            spellLogger.debug("Read target.", {target});
            return target;
        } catch (error) {
            spellLogger.warn("Could not read spell target.", {error: error.message});
            return null;
        }
    }

    async function readEffect(page: puppeteer.Page) {
        try {
            const effect = await (await page.$x("//strong[text()=\"Effect:\"]/following-sibling::text()[1]"))[0].evaluate(e => e.textContent.trim());
            spellLogger.debug("Read target.", {effect});
            return effect;
        } catch (error) {
            spellLogger.warn("Could not read spell effect.", {error: error.message});
            return null;
        }
    }

    async function readDuration(page: puppeteer.Page) {
        try {
            const duration = await (await page.$x("//strong[text()=\"Duration:\"]/following-sibling::text()[1]"))[0].evaluate(e => e.textContent.trim());
            spellLogger.debug("Read duration.", {duration});
            return duration;
        } catch (error) {
            spellLogger.warn("Could not read spell duration.", {error: error.message});
            return null;
        }
    }

    async function readSavingThrow(page: puppeteer.Page) {
        try {
            const savingThrow = await (await page.$x("//strong[text()=\"Saving Throw:\"]/following-sibling::text()[1]"))[0].evaluate(e => e.textContent.trim());
            spellLogger.debug("Read savingThrow.", {savingThrow});
            return savingThrow;
        } catch (error) {
            spellLogger.warn("Could not read spell savingThrow.", {error: error.message});
            return null;
        }
    }

    async function readSpellResistance(page: puppeteer.Page) {
        try {
            const spellResistance = await (await page.$x("//strong[text()=\"Spell Resistance:\"]/following-sibling::text()[1]"))[0].evaluate(e => e.textContent.trim());
            spellLogger.debug("Read spellResistance.", {spellResistance});
            return spellResistance;
        } catch (error) {
            spellLogger.warn("Could not read spell spellResistance.", {error: error.message});
            return null;
        }
    }

    async function readDescription(page: puppeteer.Page) {
        try {
            const description = await page.$eval("#content .nice-textile", e => e.innerHTML.trim());
            spellLogger.debug("Read description.", {description});
            return description;
        } catch (error) {
            spellLogger.warn("Could not read spell description.", {error: error.message});
            return null;
        }
    }

    const page = await browser.newPage();
    try {
        let retryCount = RETRY_LIMIT;
        while (retryCount-- > 0) {
            try {
                await page.goto(url);

                const spell: Spell = {
                    id: /(\d+)\/?$/.exec(url)[1],
                    name: await readName(page),
                    source: await readSource(page),
                    schools: await readSchools(page),
                    subschools: await readSubschools(page),
                    descriptors: await readDescriptors(page),
                    classLevels: await readClassLevels(page),
                    domainLevels: await readDomainLevels(page),
                    components: await readComponents(page),
                    castingTime: await readCastingTime(page),
                    range: await readRange(page),
                    area: await readArea(page),
                    target: await readTarget(page),
                    effect: await readEffect(page),
                    duration: await readDuration(page),
                    savingThrow: await readSavingThrow(page),
                    spellResistance: await readSpellResistance(page),
                    description: await readDescription(page)
                };

                logger.debug(`Exiting crawlSpellPage("${url})`, {spell});

                return spell;
            } catch (error) {
                if (retryCount <= 0) {
                    logger.warn("Failed to read spell.", {error: error.message, url});
                    throw error;
                } else {
                    logger.verbose("Failed to read spell page, retrying.", {error: error.message, url});
                }
            }
        }
    } finally {
        if (page) {
            await page.close();
        }
    }
}

function crawlSpellPages(browser: puppeteer.Browser, spellUrls: string[], spellCallback: (spell: Spell) => void) {
    return new Promise<void>((resolve, reject) => {
        eachLimit(spellUrls, CONCURRENCY, async (spellUrl, done) => {
            let retryCount = RETRY_LIMIT;
            let error = null;
            while (retryCount-- > 0) {
                // Keep trying until we succeed
                try {
                    const spell = await crawlSpellPage(browser, `${DNDTOOLS_URL_BASE}${spellUrl}`);
                    spellCallback(spell);
                    break;
                } catch (err) {
                    error = err;
                    logger.warn("Error when crawling spell page, retrying.", {spellUrl, error: err.message});
                }
            }

            if (retryCount > 0) {
                done();
            } else {
                done(error);
            }
        }, (err) => err ? reject(err) : resolve());
    });
}

function printSpell(spell: Spell) {
    console.log(JSON.stringify(spell));
}

(async () => {
    try {
        const browser = await puppeteer.launch({
            headless: !DEBUG,
            defaultViewport: {
                width: 1200,
                height: 1024
            }
        });
        try {
            logger.info("Building list of spells...");
            const spellUrls = await crawlSpellListPages(browser);

            if (spellUrls.length > 0) {
                logger.info("Crawling spells...", {spellCount: spellUrls.length});
                const spells: Spell[] = [];
                let spellCounter = 0;
                await crawlSpellPages(browser, spellUrls, s => {
                    logger.info("Read spell.", {spell: s.name, count: ++spellCounter, total: spellUrls.length});

                    spells.push(s);
                });

                process.stdout.write(JSON.stringify(spells, null, 2));
            } else {
                logger.info("No spells found!");
            }
        } catch (error) {
            logger.error("Unexpected error!", {error: error.message});
        } finally {
            await browser.close();            
        }
    } catch (error) {
        logger.error("Could not start browser.", {error: error.message});
    }
})();
