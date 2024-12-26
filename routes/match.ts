import express from "express";
import { generateMatchCommentary } from "../services/football/matchCommentary";
import { MatchParsedText } from "../types";
import { analyzeFootballMatch } from "../services/football/matchAnalyzer";

const router = express.Router();

router.post("/get-match", async (req, res) => {
  try {
    const { homeTeam, awayTeam } = req.body;
    if (!homeTeam || !awayTeam) {
      return res.status(400).json({
        error: "Missing required fields: homeTeam and awayTeam are required"
      });
    }

    const result = await analyzeFootballMatch(homeTeam, awayTeam);
    const parsedText: MatchParsedText = result;
    
    const content = await generateMatchCommentary(parsedText);
    
    return res.json({ success: true, content });
  } catch (error) {
    console.error("Error in /get-match:", error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

export default router;
