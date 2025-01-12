import puppeteer from "puppeteer";
import { pool } from "../../config/db";
import { WeatherService } from "../weather/WeatherService";
interface MatchData {
  id: string;
  matchInput: string;
  homeTeam: string;
  awayTeam: string;
  venue: string;
  unavailablePlayers: {
    home: string[];
    away: string[];
  };
  recentMatches: {
    home: string[];
    away: string[];
    between: string[];
  };
  weather: WeatherData;
}

interface WeatherData {
  temperature: number;
  condition: string;
  humidity: number;
  windSpeed: number;
}

function createDefaultWeatherData(): WeatherData {
  return {
    temperature: 20,
    condition: "Unknown",
    humidity: 50,
    windSpeed: 5,
  };
}

export async function analyzeFootballMatch(
  homeTeam: string,
  awayTeam: string
): Promise<MatchData> {
  const matchInput = `${homeTeam}-${awayTeam}`;

  // Check if the match data already exists in the database
  const existingMatch = await pool.query(
    'SELECT * FROM match_data WHERE id = $1',
    [matchInput]
  );

  const weatherService = WeatherService.getInstance()

  if (existingMatch.rows.length > 0) {
    return {
      id: existingMatch.rows[0].id,
      matchInput: existingMatch.rows[0].match_input,
      homeTeam,
      awayTeam,
      venue: existingMatch.rows[0].venue,
      unavailablePlayers: {
        home: existingMatch.rows[0].unavailable_players_home,
        away: existingMatch.rows[0].unavailable_players_away
      },
      recentMatches: {
        home: existingMatch.rows[0].recent_matches_home,
        away: existingMatch.rows[0].recent_matches_away,
        between: existingMatch.rows[0].recent_matches_between
      },
      weather: {
        temperature: existingMatch.rows[0].weather_temperature,
        condition: existingMatch.rows[0].weather_condition,
        humidity: existingMatch.rows[0].weather_humidity,
        windSpeed: existingMatch.rows[0].weather_wind_speed
      }
    };
  }

  // If not found, proceed with scraping
  const matchId = await searchMatch(matchInput);
  const matchDetails = await getMatchDetails(matchId, homeTeam, awayTeam);
  const h2hData = await getH2HData(matchId, homeTeam, awayTeam);
  const weatherData = matchDetails.venue
    ? await weatherService.getWeatherData(matchDetails.venue)
    : weatherService.createDefaultWeatherData();

  const matchData: MatchData = {
    id: matchInput,
    matchInput: matchInput,
    homeTeam: homeTeam,
    awayTeam: awayTeam,
    unavailablePlayers: matchDetails.unavailablePlayers ?? {
      home: [],
      away: [],
    },
    venue: matchDetails.venue ?? "",
    weather: weatherData,
    recentMatches: h2hData.recentMatches || { home: [], away: [], between: [] },
  };
  // Save to PostgreSQL
  
  await pool.query(
    `INSERT INTO match_data (
      id, match_input, venue, 
      unavailable_players_home, unavailable_players_away,
      recent_matches_home, recent_matches_away, recent_matches_between,
      weather_temperature, weather_condition, weather_humidity, weather_wind_speed
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (id) DO UPDATE SET
      match_input = EXCLUDED.match_input,
      venue = EXCLUDED.venue,
      unavailable_players_home = EXCLUDED.unavailable_players_home,
      unavailable_players_away = EXCLUDED.unavailable_players_away,
      recent_matches_home = EXCLUDED.recent_matches_home,
      recent_matches_away = EXCLUDED.recent_matches_away,
      recent_matches_between = EXCLUDED.recent_matches_between,
      weather_temperature = EXCLUDED.weather_temperature,
      weather_condition = EXCLUDED.weather_condition,
      weather_humidity = EXCLUDED.weather_humidity,
      weather_wind_speed = EXCLUDED.weather_wind_speed`,
    [
      matchData.id,
      matchData.matchInput,
      matchData.venue,
      matchData.unavailablePlayers.home,
      matchData.unavailablePlayers.away,
      matchData.recentMatches.home,
      matchData.recentMatches.away,
      matchData.recentMatches.between,
      matchData.weather.temperature,
      matchData.weather.condition,
      matchData.weather.humidity,
      matchData.weather.windSpeed
    ]
  );

  return matchData;
}

async function searchMatch(matchInput: string): Promise<string> {
  const url = `https://www.bilyoner.com/iddaa`;
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });

    // Check if we're redirected to a different page (e.g., Cloudflare challenge)
    if (!page.url().includes("bilyoner.com")) {
      throw new Error("Page redirected, possibly due to anti-bot protection");
    }

    // Wait for the content to load
    await page.waitForSelector(".sportsbookList", { timeout: 10000 });

    const matchElement = await page.evaluate(async (input) => {
      const scrollContainer = document.querySelector(".sportsbookList");
      let matchId = null;
      let lastHeight = 0;
      const scrollStep = 300;
      let scrollAttempts = 0;
      const maxScrollAttempts = 20;

      while (!matchId && scrollAttempts < maxScrollAttempts) {
        const items = Array.from(
          document.querySelectorAll(".events-container__item")
        );
        for (const item of items) {
          const linkElement = item.querySelector(
            ".event-row-prematch__cells__teams"
          );
          if (linkElement) {
            const teams = linkElement.textContent
              ?.split("-")
              .map((team) => team.trim());
            if (
              teams &&
              teams.length === 2 &&
              teams[0].includes(input.split("-")[0]) &&
              teams[1].includes(input.split("-")[1])
            ) {
              matchId = item.id;
              break;
            }
          }
        }

        if (matchId) break;

        if (scrollContainer) {
          scrollContainer.scrollTop += scrollStep;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        const newHeight = scrollContainer?.scrollHeight || 0;
        if (newHeight === lastHeight) {
          scrollAttempts++;
        } else {
          scrollAttempts = 0;
        }
        lastHeight = newHeight;
      }

      return matchId;
    }, matchInput);

    if (!matchElement) {
      console.log(`No match found for input: ${matchInput}`);
      throw new Error("Match not found");
    }

    console.log("Match found. ID:", matchElement);
    return matchElement;
  } catch (error) {
    console.error(`Error in searchMatch: ${error}`);
    throw error;
  } finally {
    await browser.close();
  }
}

async function getMatchDetails(
  matchId: string,
  homeTeam: string,
  awayTeam: string
): Promise<Partial<MatchData>> {
  const unavailablePlayersUrl = `https://www.bilyoner.com/mac-karti/futbol/${matchId}/sakat-cezali`;
  const detailsUrl = `https://www.bilyoner.com/mac-karti/futbol/${matchId}/detay`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  const page = await browser.newPage();

  try {
    await page.goto(detailsUrl, { waitUntil: "networkidle0" });
    const venue = await page.$eval(
      ".match-detail__match-info__list__item:last-child .match-detail__match-info__list__item__text",
      (el) => el.textContent?.trim() ?? ""
    );

    await page.goto(unavailablePlayersUrl, { waitUntil: "networkidle0" });

    const getUnavailablePlayers = async (team: string) => {
      return page.evaluate((teamName) => {
        const allAvailableMessage = "Tüm oyuncular maç için hazır.";
        const titleElements = Array.from(
          document.querySelectorAll(".injured-banned__content__title")
        );
        const teamTitleElement = titleElements.find((el) =>
          el.textContent?.includes(teamName)
        );

        if (!teamTitleElement) return [];

        const nextElement = teamTitleElement.nextElementSibling;

        if (nextElement?.textContent?.includes(allAvailableMessage)) {
          return [];
        }

        if (nextElement?.classList.contains("injured-banned__table")) {
          const rows = nextElement.querySelectorAll(
            ".injured-banned__table__body__row"
          );
          return Array.from(rows).map((row) => {
            const name = row
              .querySelector(
                ".injured-banned__table__body__row__columns__column strong"
              )
              ?.textContent?.trim();
            const status = row
              .querySelector(
                ".injured-banned__table__body__row__columns__column span"
              )
              ?.textContent?.trim();
            return `${name} (${status})`;
          });
        }

        return [];
      }, team);
    };

    const unavailablePlayers = {
      home: await getUnavailablePlayers(homeTeam),
      away: await getUnavailablePlayers(awayTeam),
    };
    return { venue, unavailablePlayers };
  } catch (error) {
    console.error(`Error in getMatchDetails: ${error}`);
    return { venue: "", unavailablePlayers: { home: [], away: [] } };
  } finally {
    await browser.close();
  }
}

async function getH2HData(
  matchId: string,
  homeTeam: string,
  awayTeam: string
): Promise<Partial<MatchData>> {
  const url = `https://www.bilyoner.com/mac-karti/futbol/${matchId}/karsilastirma`;
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox"],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle0" });

    const getMatches = async (selector: string, type: string) => {
      // Check if the "expand" button exists and click it if present
      const expandButtonSelector = `${selector} .quick-statistics__table__body__row__open-button`;
      const expandButton = await page.$(expandButtonSelector);
      if (expandButton) {
        await expandButton.click();
        await page.waitForNetworkIdle(); // Replace waitForTimeout with waitForNetworkIdle
      }

      return page.$$eval(`${selector} .team-against-row`, (rows) =>
        rows.map((row) => {
          const date = row
            .querySelector(".team-against-row__date")
            ?.textContent?.trim()
            .split(" ")[0];
          const homeTeam = row
            .querySelector(".team-against-row__home span")
            ?.textContent?.trim();
          const awayTeam = row
            .querySelector(".team-against-row__away span")
            ?.textContent?.trim();
          const score = row.querySelector(".icon-score")?.textContent?.trim();
          const halfTimeScore = row
            .querySelector(".team-against-row__score--half-time")
            ?.textContent?.trim()
            .split(":")[1]
            .trim();
          return `${date}: ${homeTeam} vs ${awayTeam} (FT: ${score} - HT: ${halfTimeScore})`;
        })
      );
    };

    const getBetweenMatches = async () => {
      return page.$$eval(
        ".quick-statistics__table--last-5-match .quick-statistics__table__body .team-against-row",
        (rows) =>
          rows.map((row) => {
            const date = row
              .querySelector(".team-against-row__date")
              ?.textContent?.trim()
              .split(" ")[0];
            const homeTeam = row
              .querySelector(".team-against-row__home span")
              ?.textContent?.trim();
            const awayTeam = row
              .querySelector(".team-against-row__away span")
              ?.textContent?.trim();
            const score = row.querySelector(".icon-score")?.textContent?.trim();
            const halfTimeScore = row
              .querySelector(".team-against-row__half-time")
              ?.textContent?.trim()
              .split(":")[1]
              .trim();
            return `${date}: ${homeTeam} vs ${awayTeam} (FT: ${score} - HT: ${halfTimeScore})`;
          })
      );
    };

    const recentMatches: {
      home: string[];
      away: string[];
      between: string[];
    } = { home: [], away: [], between: [] };

    recentMatches.home = await getMatches(
      ".quick-statistics__table:nth-child(1) .quick-statistics__table__body",
      `${homeTeam}`
    );
    recentMatches.away = await getMatches(
      ".quick-statistics__table:nth-child(2) .quick-statistics__table__body",
      `${awayTeam}`
    );

    await page.evaluate(() => {
      const tabElement = document.querySelector('label[for="tab1_1"]');
      if (tabElement) {
        (tabElement as HTMLElement).click();
      } else {
        console.error("Tab element not found");
      }
    });

    try {
      const betweenMatches = await getBetweenMatches();
      recentMatches.between = betweenMatches;
    } catch (fetchError) {
      console.error("Error fetching head-to-head matches:", fetchError);
      recentMatches.between = [];
    }

    return { recentMatches };
  } catch (error) {
    console.error(`Error fetching H2H data: ${error}`);
    throw error;
  } finally {
    await browser.close();
  }
}