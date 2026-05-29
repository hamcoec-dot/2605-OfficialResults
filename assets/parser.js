/* ==========================================================================
   Hamilton County Election Commission - Election Data Parser
   Created: May 2026
   Standards: Pure ASCII, Robust State-Machine CSV Parsing, Zeros-Padding Matching
   ========================================================================== */

(function(global) {
  'use strict';

  const ElectionParser = {
    /**
     * Parses standard CSV text using a state-machine loop.
     * Correctly handles quoted commas, escaped quotes (""), and line breaks.
     * @param {string} text - The raw CSV content.
     * @returns {Array<Array<string>>} 2D array of parsed cells.
     */
    parseCSV: function(text) {
      const lines = [];
      let row = [""];
      let inQuotes = false;
      
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        
        if (c === '"') {
          if (inQuotes && next === '"') {
            // Escaped quote
            row[row.length - 1] += '"';
            i++; // skip next quote
          } else {
            // Toggle quotes state
            inQuotes = !inQuotes;
          }
        } else if (c === ',' && !inQuotes) {
          row.push("");
        } else if ((c === '\r' || c === '\n') && !inQuotes) {
          if (c === '\r' && next === '\n') {
            i++; // handle CRLF
          }
          lines.push(row);
          row = [""];
        } else {
          row[row.length - 1] += c;
        }
      }
      
      if (row.length > 1 || row[0] !== "") {
        lines.push(row);
      }
      
      // Clean up whitespace inside cells
      return lines.map(r => r.map(cell => cell.trim()));
    },

    /**
     * Parses the "Export with No Groups" CSV lines.
     * Sets up the master dataStore and extracts county totals.
     * @param {Array<Array<string>>} lines - 2D CSV array.
     * @returns {Object} Structured data store.
     */
    processNoGroupsData: function(lines) {
      if (lines.length < 4) {
        throw new Error("Invalid CSV format: Too few rows.");
      }

      const contestsRow = lines[0];
      const partiesRow = lines[1];
      const candidatesRow = lines[2];
      
      const dataStore = {
        precincts: {},
        contests: {},
        countySummary: {
          voters: 0,
          ballots: { total: 0, rep: 0, dem: 0 }
        }
      };

      // Determine where the contest columns start.
      // Columns 0-6 are standard attributes (Precinct Code, Name, Turnout, etc.)
      const contestStartIndex = 7;

      // Extract contests and candidates structure from headers
      for (let col = contestStartIndex; col < contestsRow.length; col++) {
        const contestName = contestsRow[col];
        const partyName = partiesRow[col] || "NON";
        const candidateName = candidatesRow[col];

        if (!contestName || !candidateName) continue;

        if (!dataStore.contests[contestName]) {
          dataStore.contests[contestName] = {
            name: contestName,
            party: partyName,
            candidates: [],
            columns: []
          };
        }

        // Add candidate to list if not already present
        if (!dataStore.contests[contestName].candidates.includes(candidateName)) {
          dataStore.contests[contestName].candidates.push(candidateName);
        }

        // Record the column index mapping for quick lookup during row processing
        dataStore.contests[contestName].columns.push({
          index: col,
          candidate: candidateName
        });
      }

      // Process rows 3+ (Precinct rows and ZZZ county totals)
      for (let r = 3; r < lines.length; r++) {
        const row = lines[r];
        if (row.length < 5) continue; // skip empty rows

        const rawCode = row[1] || "";
        const precinctName = row[2] || "";
        
        if (!rawCode || !precinctName) continue;
        
        const precinctCode = rawCode.trim().padStart(4, '0');
        const registeredVoters = parseInt(row[3]) || 0;
        const ballotsTotal = parseInt(row[4]) || 0;
        const ballotsRep = parseInt(row[5]) || 0;
        const ballotsDem = parseInt(row[6]) || 0;

        // If it's the County Totals row (starts with code ZZZ)
        if (precinctCode === "0ZZZ" || precinctCode === "ZZZZ" || precinctName.toUpperCase() === "COUNTY TOTALS") {
          dataStore.countySummary.voters = registeredVoters;
          dataStore.countySummary.ballots.total = ballotsTotal;
          dataStore.countySummary.ballots.rep = ballotsRep;
          dataStore.countySummary.ballots.dem = ballotsDem;

          // Fill in county totals for each candidate in the contests list
          for (const contestName in dataStore.contests) {
            const contest = dataStore.contests[contestName];
            contest.countyTotals = {};
            contest.columns.forEach(colMapping => {
              const votes = parseInt(row[colMapping.index]) || 0;
              contest.countyTotals[colMapping.candidate] = (contest.countyTotals[colMapping.candidate] || 0) + votes;
            });
          }
          continue; // Don't add ZZZ as a standard precinct
        }

        // Standard precinct record
        const precinctRecord = {
          code: precinctCode,
          name: precinctName,
          voters: registeredVoters,
          ballots: {
            total: ballotsTotal,
            rep: ballotsRep,
            dem: ballotsDem
          },
          results: {},
          groups: {} // will be populated by processGroupsData
        };

        // Populate precinct candidate results
        for (const contestName in dataStore.contests) {
          const contest = dataStore.contests[contestName];
          precinctRecord.results[contestName] = {};
          
          contest.columns.forEach(colMapping => {
            const votes = parseInt(row[colMapping.index]) || 0;
            precinctRecord.results[contestName][colMapping.candidate] = votes;
          });
        }

        dataStore.precincts[precinctCode] = precinctRecord;
      }

      return dataStore;
    },

    /**
     * Parses the "Export with Groups" CSV lines and merges the group-level
     * breakdowns (Election Day, Early Voting, etc.) into the dataStore.
     * @param {Array<Array<string>>} lines - 2D CSV array.
     * @param {Object} dataStore - The parsed store from processNoGroupsData.
     */
    processGroupsData: function(lines, dataStore) {
      if (lines.length < 4 || !dataStore) return;

      const contestsRow = lines[0];
      const candidatesRow = lines[2];
      const contestStartIndex = 7;

      // Group column indices
      // Column 0 is Counting Group name
      // Column 1 is Precinct Code
      // Column 2 is Precinct Name

      for (let r = 3; r < lines.length; r++) {
        const row = lines[r];
        if (row.length < 5) continue;

        const groupName = row[0] || "";
        const rawCode = row[1] || "";
        const precinctName = row[2] || "";

        if (!groupName || !rawCode || !precinctName) continue;
        if (precinctName.toUpperCase() === "COUNTY TOTALS" || rawCode.toUpperCase() === "ZZZ") continue;

        const precinctCode = rawCode.trim().padStart(4, '0');
        const precinct = dataStore.precincts[precinctCode];

        if (!precinct) {
          // If we encounter a precinct not in the main list, ignore or skip
          continue;
        }

        const ballotsTotal = parseInt(row[4]) || 0;
        const ballotsRep = parseInt(row[5]) || 0;
        const ballotsDem = parseInt(row[6]) || 0;

        // Initialize group inside precinct
        if (!precinct.groups[groupName]) {
          precinct.groups[groupName] = {
            name: groupName,
            ballots: {
              total: ballotsTotal,
              rep: ballotsRep,
              dem: ballotsDem
            },
            results: {}
          };
        }

        // Loop through columns to save vote breakdown
        for (let col = contestStartIndex; col < row.length; col++) {
          const contestName = contestsRow[col];
          const candidateName = candidatesRow[col];
          const votes = parseInt(row[col]) || 0;

          if (!contestName || !candidateName) continue;

          // Double check if this contest is in our main store
          if (dataStore.contests[contestName]) {
            if (!precinct.groups[groupName].results[contestName]) {
              precinct.groups[groupName].results[contestName] = {};
            }
            precinct.groups[groupName].results[contestName][candidateName] = votes;
          }
        }
      }
    }
  };

  // Export parser to global window namespace
  global.ElectionParser = ElectionParser;

})(window);
