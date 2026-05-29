/* ==========================================================================
   Hamilton County Election Commission - Election Coordinator JS
   Created: May 2026
   Standards: Pure ASCII, DNN CMS Interactivity, WCAG 2.1 AA Focus-Management
   Refinement: Strict CSV Ordering, No Write-ins, Integrated School Filters, CSV Export
   ========================================================================== */

(function(global) {
  'use strict';

  const ElectionApp = {
    // Application State
    state: {
      dataLoaded: false,
      activeFilter: 'ALL', // ALL, REP, DEM, NON
      searchQuery: '',
      selectedContest: '',
      sortColumn: 'default', // 'default' preserves exact CSV order; otherwise precinct, voters, ballots, turnout, or candidate
      sortAscending: true,
      focusedTriggerElement: null
    },

    // Initialization
    init: function() {
      this.initTheme();
      this.loadData();
    },

    // 1. Persisted Theme Manager (Light / Dark Mode)
    initTheme: function() {
      let savedTheme = null;
      try {
        savedTheme = localStorage.getItem('hcec-theme');
      } catch (e) {
        console.warn("Storage access denied. Persistent theme disabled.");
      }
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      
      if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
        document.body.classList.add('dark');
      } else {
        document.body.classList.remove('dark');
      }
    },

    toggleTheme: function() {
      const isDark = document.body.classList.toggle('dark');
      try {
        localStorage.setItem('hcec-theme', isDark ? 'dark' : 'light');
      } catch (e) {
        console.warn("Storage write denied. Theme preference not saved.");
      }
    },

    // 2. Data Fetcher & Aggregator
    loadData: function() {
      // If data is already loaded statically (via data.js script in index/precincts)
      if (global.electionData) {
        this.state.dataLoaded = true;
        
        // Auto-select first contest as default, or URL contest if present in exact CSV order
        const cOrder = global.electionData.contestsOrder || Object.keys(global.electionData.contests);
        const params = new URLSearchParams(window.location.search);
        const urlContest = params.get('contest');
        if (urlContest && global.electionData.contests[urlContest]) {
          this.state.selectedContest = urlContest;
        } else if (cOrder.length > 0) {
          this.state.selectedContest = cOrder[0];
        }
        
        this.render();
        return;
      }
      
      // Dynamic Fetch Fallback (if they decide to load CSVs dynamically)
      const noGroupsUrl = 'data/2026-05-05%20-%20County%20Primary%20-%20Export%20with%20No%20Groups.CSV';
      const withGroupsUrl = 'data/2026-05-05%20-%20County%20Primary%20-%20Export%20with%20Groups.CSV';

      Promise.all([
        fetch(noGroupsUrl).then(res => {
          if (!res.ok) throw new Error("No Groups CSV could not be fetched.");
          return res.text();
        }),
        fetch(withGroupsUrl).then(res => {
          if (!res.ok) throw new Error("With Groups CSV could not be fetched.");
          return res.text();
        })
      ])
      .then(([noGroupsText, withGroupsText]) => {
        const noGroupsLines = global.ElectionParser.parseCSV(noGroupsText);
        const withGroupsLines = global.ElectionParser.parseCSV(withGroupsText);

        // Core data structure setup
        const dataStore = global.ElectionParser.processNoGroupsData(noGroupsLines);
        global.ElectionParser.processGroupsData(withGroupsLines, dataStore);

        global.electionData = dataStore;
        this.state.dataLoaded = true;

        // Auto-select first contest as default, or URL contest if present in exact CSV order
        const contestKeys = dataStore.contestsOrder || Object.keys(dataStore.contests);
        const params = new URLSearchParams(window.location.search);
        const urlContest = params.get('contest');
        if (urlContest && dataStore.contests[urlContest]) {
          this.state.selectedContest = urlContest;
        } else if (contestKeys.length > 0) {
          this.state.selectedContest = contestKeys[0];
        }

        // Fire UI render event
        this.render();
      })
      .catch(err => {
        console.error("HCEC Data Load Error: ", err);
        const errorEl = document.getElementById('error-message');
        if (errorEl) {
          errorEl.textContent = "Error loading election results. Please try reloading the page.";
          errorEl.style.display = 'block';
        }
      });
    },

    // 3. Page Router Rendering Controller
    render: function() {
      if (!this.state.dataLoaded) return;

      const path = window.location.pathname;
      const isPrecinctPage = path.includes('precincts.html');

      if (isPrecinctPage) {
        this.renderPrecinctPage();
      } else {
        this.renderDashboard();
      }
    },

    // 4. Page 1: County-Wide Results Dashboard Renderer
    renderDashboard: function() {
      const dataStore = global.electionData;
      if (!dataStore) return;

      // Render turnout banner totals
      const turnoutVal = ((dataStore.countySummary.ballots.total / dataStore.countySummary.voters) * 100).toFixed(2);
      
      const elVoters = document.getElementById('stat-voters');
      const elBallots = document.getElementById('stat-ballots');
      const elTurnout = document.getElementById('stat-turnout');
      
      if (elVoters) elVoters.textContent = dataStore.countySummary.voters.toLocaleString();
      if (elBallots) elBallots.textContent = dataStore.countySummary.ballots.total.toLocaleString();
      if (elTurnout) elTurnout.textContent = turnoutVal + '%';

      // Render contest grid
      const grid = document.getElementById('contest-grid');
      if (!grid) return;
      grid.innerHTML = '';

      let contestsCount = 0;
      
      // Refinement: Maintain exact CSV order of the offices (contestsOrder)
      const contestsList = dataStore.contestsOrder || Object.keys(dataStore.contests);
      
      contestsList.forEach(contestName => {
        const contest = dataStore.contests[contestName];
        if (!contest) return;

        // Search Query Filtering (Write-ins are already excluded in compiler)
        if (this.state.searchQuery) {
          const query = this.state.searchQuery.toLowerCase();
          const matchContest = contest.name.toLowerCase().includes(query);
          const matchCandidate = contest.candidates.some(c => c.toLowerCase().includes(query));
          if (!matchContest && !matchCandidate) return;
        }

        // Party Category Filtering (REP and DEM school board races naturally combined here)
        if (this.state.activeFilter !== 'ALL') {
          if (this.state.activeFilter === 'REP' && contest.party !== 'REP') return;
          if (this.state.activeFilter === 'DEM' && contest.party !== 'DEM') return;
          if (this.state.activeFilter === 'NON' && contest.party !== 'NON') return;
        }

        contestsCount++;

        // Calculate reporting and eligible precinct statistics for this specific contest
        let reportingCount = 0;
        let eligibleCount = 0;
        const pOrderList = dataStore.precinctsOrder || Object.keys(dataStore.precincts);
        pOrderList.forEach(code => {
          const p = dataStore.precincts[code];
          if (!p) return;
          
          let hasVotes = false;
          contest.candidates.forEach(cand => {
            const votes = p.results[contestName] ? (p.results[contestName][cand] || 0) : 0;
            if (votes > 0) hasVotes = true;
          });
          
          if (hasVotes) {
            reportingCount++;
            eligibleCount++;
          }
        });

        // Identify Winner/Leader (Candidate with highest votes)
        let maxVotes = -1;
        let leaderName = '';
        let totalContestVotes = 0;

        contest.candidates.forEach(cand => {
          const votes = contest.countyTotals[cand] || 0;
          totalContestVotes += votes;
          if (votes > maxVotes) {
            maxVotes = votes;
            leaderName = cand;
          }
        });

        // HTML Card Creation
        const card = document.createElement('div');
        card.className = 'contest-card';

        let partyClass = 'non';
        if (contest.party === 'REP') partyClass = 'rep';
        if (contest.party === 'DEM') partyClass = 'dem';

        let cardHtml = `
          <div class="contest-header">
            <h3 class="font-size-subtitle" style="margin-bottom: 4px !important;">${contest.name}</h3>
            <span class="contest-party-badge ${partyClass}">${contest.party}</span>
          </div>
          <div class="contest-candidate-list">
        `;

        // Refinement: Maintain candidate names in exact CSV order (left-to-right columns)
        const candidatesToShow = contest.candidates; // DO NOT SORT BY VOTE COUNT

        candidatesToShow.forEach((cand, idx) => {
          const votes = contest.countyTotals[cand] || 0;
          const share = totalContestVotes > 0 ? ((votes / totalContestVotes) * 100).toFixed(2) : '0.00';
          const isWinner = cand === leaderName && votes > 0;
          
          // Same color scheme as the pie chart (completely avoiding red/blue)
          const colors = ['#10b981', '#f59e0b', '#8b5cf6', '#d946ef', '#14b8a6', '#eab308', '#84cc16', '#d97706', '#a78bfa', '#059669'];
          const color = colors[idx % colors.length];

          cardHtml += `
            <div class="candidate-row">
              <div class="candidate-info">
                <div class="candidate-name-wrapper">
                  <span class="candidate-party-dot" style="background-color: ${color} !important;" aria-hidden="true"></span>
                  <span class="${isWinner ? 'text-semibold' : ''}">${cand}</span>
                  ${isWinner ? '<span class="winner-icon" aria-hidden="true">&#x2705;</span><span class="sr-only">(Winner)</span>' : ''}
                </div>
                <div class="candidate-stats">
                  <span class="text-semibold">${votes.toLocaleString()}</span>
                  <span class="font-size-tiny text-muted nowrap" style="margin-left: 6px !important;">${share}%</span>
                </div>
              </div>
              <div class="vote-bar-container">
                <div class="vote-bar-fill" style="width: ${share}% !important; background-color: ${color} !important;" aria-hidden="true"></div>
              </div>
            </div>
          `;
        });

        const isNoCandidate = contest.isNoCandidateQualified;
        
        let reportingBadgeHtml = '';
        if (isNoCandidate) {
          reportingBadgeHtml = `<span class="text-semibold text-muted">&#x26A0;&#xFE0F; No Candidate Qualified</span>`;
        } else {
          reportingBadgeHtml = `
            <span class="text-semibold" style="color: var(--success); display: inline-flex; align-items: center; gap: 4px;">
              &#x2705; ${reportingCount}/${eligibleCount} Precincts Reporting
            </span>
          `;
        }

        cardHtml += `
          </div>
          <div class="contest-footer font-size-tiny" style="display: flex; flex-direction: column; gap: 8px !important;">
            <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
              <span>Total Votes: <strong class="text-main">${totalContestVotes.toLocaleString()}</strong></span>
              ${reportingBadgeHtml}
            </div>
            <div style="display: flex; justify-content: space-between; width: 100%; border-top: 1px solid var(--border-color); padding-top: 8px !important; align-items: center;">
              <span class="text-muted">${isNoCandidate ? 'No Contest' : '100% Complete'}</span>
              <a href="precincts.html?contest=${encodeURIComponent(contest.name)}" class="map-link font-size-tiny" aria-label="View precinct results for ${contest.name}">
                Precinct Splits &#x2192;
              </a>
            </div>
          </div>
        `;

        card.innerHTML = cardHtml;
        grid.appendChild(card);
      });

      // Handle Empty States
      const noResultsEl = document.getElementById('no-contests-message');
      if (contestsCount === 0) {
        if (noResultsEl) noResultsEl.style.display = 'block';
      } else {
        if (noResultsEl) noResultsEl.style.display = 'none';
      }
    },

    // 5. Page 2: Precinct Results Matrix Renderer
    renderPrecinctPage: function() {
      const dataStore = global.electionData;
      if (!dataStore) return;

      // Populate contest selector dropdown in exact CSV order
      const selector = document.getElementById('contest-selector');
      if (selector && selector.options.length <= 1) {
        selector.innerHTML = '<option value="" disabled>-- Choose a Contest to Display --</option>';
        
        // Refinement: Maintain exact CSV order in the dropdown selector
        const contestsListOrder = dataStore.contestsOrder || Object.keys(dataStore.contests);
        
        contestsListOrder.forEach(contestName => {
          const opt = document.createElement('option');
          opt.value = contestName;
          opt.textContent = contestName;
          if (contestName === this.state.selectedContest) {
            opt.selected = true;
          }
          selector.appendChild(opt);
        });
      }

      // URL parameters are parsed once in loadData to avoid resetting the combo box selector on render

      const activeContestName = this.state.selectedContest;
      const contest = dataStore.contests[activeContestName];

      let reportingCount = 0;
      let eligibleCount = 0;

      if (contest) {
        const pOrderList = dataStore.precinctsOrder || Object.keys(dataStore.precincts);
        pOrderList.forEach(code => {
          const p = dataStore.precincts[code];
          if (!p) return;
          
          let hasVotes = false;
          contest.candidates.forEach(cand => {
            const votes = p.results[activeContestName] ? (p.results[activeContestName][cand] || 0) : 0;
            if (votes > 0) hasVotes = true;
          });
          
          if (hasVotes) {
            reportingCount++;
            eligibleCount++;
          }
        });
      }

        const isNoCandidate = contest.isNoCandidateQualified;
        
        const headerTitle = document.getElementById('selected-contest-title');
        if (headerTitle) {
          if (activeContestName && contest) {
            if (isNoCandidate) {
              headerTitle.innerHTML = `
                <span>${activeContestName}</span>
                <span class="font-size-tiny text-semibold" style="color: var(--text-muted) !important; background-color: var(--border-color); padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border-color); margin-left: 12px; display: inline-flex; align-items: center; gap: 4px; text-transform: uppercase;">
                  &#x26A0;&#xFE0F; No Candidate Qualified
                </span>
              `;
            } else {
              headerTitle.innerHTML = `
                <span>${activeContestName}</span>
                <span class="font-size-tiny text-semibold" style="color: var(--success) !important; background-color: var(--success-bg); padding: 4px 8px; border-radius: 4px; border: 1px solid rgba(21, 128, 61, 0.15); margin-left: 12px; display: inline-flex; align-items: center; gap: 4px; text-transform: uppercase;">
                  &#x2705; ${reportingCount}/${eligibleCount} Precincts Reporting (100%)
                </span>
              `;
            }
          } else {
            headerTitle.textContent = "Select a Contest";
          }
        }

      const tableHead = document.getElementById('table-head-row');
      const tableBody = document.getElementById('table-body');
      
      if (!tableHead || !tableBody) return;

      tableHead.innerHTML = '';
      tableBody.innerHTML = '';

      if (!contest) {
        tableBody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">Select a contest above to view precinct level breakdowns.</td></tr>`;
        return;
      }

      // Build Headers dynamically (candidates appear in exact CSV column order)
      let headHtml = `
        <th class="sortable" onclick="ElectionApp.toggleSort('precinct')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ') ElectionApp.toggleSort('precinct')" aria-sort="${this.getAriaSort('precinct')}">
          Precinct Name ${this.getSortIcon('precinct')}
        </th>
        <th class="sortable text-right" onclick="ElectionApp.toggleSort('voters')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ') ElectionApp.toggleSort('voters')" aria-sort="${this.getAriaSort('voters')}">
          Registered Voters ${this.getSortIcon('voters')}
        </th>
        <th class="sortable text-right" onclick="ElectionApp.toggleSort('ballots')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ') ElectionApp.toggleSort('ballots')" aria-sort="${this.getAriaSort('ballots')}">
          Turnout ${this.getSortIcon('ballots')}
        </th>
      `;

      contest.candidates.forEach(cand => {
        headHtml += `
          <th class="sortable text-right" onclick="ElectionApp.toggleSort('${cand}')" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' ') ElectionApp.toggleSort('${cand}')" aria-sort="${this.getAriaSort(cand)}">
            ${cand} ${this.getSortIcon(cand)}
          </th>
        `;
      });
      tableHead.innerHTML = headHtml;

      // Extract and filter precinct rows in exact CSV order (top-to-bottom)
      let precinctsList = [];
      const pOrderList = dataStore.precinctsOrder || Object.keys(dataStore.precincts);
      
      pOrderList.forEach(code => {
        const p = dataStore.precincts[code];
        if (!p) return;
        
        // Filter by Query
        if (this.state.searchQuery) {
          const q = this.state.searchQuery.toLowerCase();
          const matchCode = p.code.toLowerCase().includes(q);
          const matchName = p.name.toLowerCase().includes(q);
          if (!matchCode && !matchName) return;
        }

        // Suppress precinct if all candidates in this contest have 0 votes
        let hasVotes = false;
        contest.candidates.forEach(cand => {
          const votes = p.results[activeContestName] ? (p.results[activeContestName][cand] || 0) : 0;
          if (votes > 0) {
            hasVotes = true;
          }
        });
        if (!hasVotes) return;

        precinctsList.push(p);
      });

      // Sorting Algorithm (Preserves original CSV order if column is 'default')
      if (this.state.sortColumn !== 'default') {
        precinctsList.sort((a, b) => {
          let valA, valB;

          if (this.state.sortColumn === 'precinct') {
            valA = a.name.toUpperCase();
            valB = b.name.toUpperCase();
          } else if (this.state.sortColumn === 'voters') {
            valA = a.voters;
            valB = b.voters;
          } else if (this.state.sortColumn === 'ballots') {
            // Sort by turnout percentage
            valA = a.voters > 0 ? (a.ballots.total / a.voters) : 0;
            valB = b.voters > 0 ? (b.ballots.total / b.voters) : 0;
          } else {
            // Sort by specific candidate votes
            valA = a.results[activeContestName] ? (a.results[activeContestName][this.state.sortColumn] || 0) : 0;
            valB = b.results[activeContestName] ? (b.results[activeContestName][this.state.sortColumn] || 0) : 0;
          }

          if (valA < valB) return this.state.sortAscending ? -1 : 1;
          if (valA > valB) return this.state.sortAscending ? 1 : -1;
          return 0;
        });
      }

      // Render precinct rows in exact state order
      precinctsList.forEach(p => {
        const turnoutPercent = p.voters > 0 ? ((p.ballots.total / p.voters) * 100).toFixed(2) : '0.00';

        const row = document.createElement('tr');
        row.style.cursor = 'pointer';
        row.setAttribute('onclick', `ElectionApp.openGroupsModal(event, '${p.code}')`);

        let rowHtml = `
          <td data-label="Precinct Name">
            <button type="button" class="btn btn-outline btn-sm font-size-small text-semibold" 
                    aria-label="View Counting Group details for precinct ${p.name}">
              ${p.name}
            </button>
          </td>
          <td class="text-right" data-label="Registered Voters">${p.voters.toLocaleString()}</td>
          <td class="text-right" data-label="Turnout">
            <div>${p.ballots.total.toLocaleString()}</div>
            <div class="font-size-tiny text-muted nowrap">${turnoutPercent}%</div>
          </td>
        `;

        contest.candidates.forEach(cand => {
          const votes = p.results[activeContestName] ? (p.results[activeContestName][cand] || 0) : 0;
          rowHtml += `<td class="text-right text-semibold" data-label="${cand}">${votes.toLocaleString()}</td>`;
        });

        row.innerHTML = rowHtml;
        tableBody.appendChild(row);
      });

      // Render County Summary row at the bottom (Ground truth ZZZ data)
      const countyTotalTurnout = dataStore.countySummary.voters > 0 
        ? ((dataStore.countySummary.ballots.total / dataStore.countySummary.voters) * 100).toFixed(2) 
        : '0.00';
      
        const isNoCandidate = contest.isNoCandidateQualified;
        const totalRowLabel = isNoCandidate 
          ? 'County Totals (No Candidate Qualified)' 
          : `County Totals (${reportingCount}/${eligibleCount} Reporting)`;

        const totalRow = document.createElement('tr');
        totalRow.className = 'total-row';
        let totalRowHtml = `
          <td data-label="Precinct Name">${totalRowLabel}</td>
          <td class="text-right" data-label="Registered Voters">${dataStore.countySummary.voters.toLocaleString()}</td>
          <td class="text-right" data-label="Turnout">
            <div>${dataStore.countySummary.ballots.total.toLocaleString()}</div>
            <div class="font-size-tiny text-muted nowrap">${countyTotalTurnout}%</div>
          </td>
        `;

      contest.candidates.forEach(cand => {
        const votes = contest.countyTotals[cand] || 0;
        totalRowHtml += `<td class="text-right text-bold" data-label="${cand}">${votes.toLocaleString()}</td>`;
      });
      totalRow.innerHTML = totalRowHtml;
      tableBody.appendChild(totalRow);

      // Render dynamic Vote Distribution Pie Chart (Playbook Rich Aesthetics)
      const chartCard = document.getElementById('contest-chart-card');
      if (chartCard) {
        chartCard.style.display = 'block';
        
        let totalVotes = 0;
        contest.candidates.forEach(cand => {
          totalVotes += contest.countyTotals[cand] || 0;
        });

        const legendContainer = document.getElementById('chart-legend');
        const svgEl = document.getElementById('pie-svg');
        
        if (legendContainer && svgEl) {
          legendContainer.innerHTML = '';
          svgEl.innerHTML = '';

          if (totalVotes === 0) {
            svgEl.innerHTML = `
              <circle cx="50" cy="50" r="40" fill="var(--primary-light)" stroke="var(--border-color)" stroke-width="1"></circle>
              <text x="50" y="53" text-anchor="middle" font-size="7" fill="var(--text-muted)" font-family="sans-serif" font-weight="600">No Votes</text>
            `;
          } else {
            let accumulatedAngle = -Math.PI / 2; // Start at 12 o'clock (top center)
            let svgHtml = '';
            let svgTextHtml = '';
            let legendHtml = '';

            contest.candidates.forEach((cand, idx) => {
              const votes = contest.countyTotals[cand] || 0;
              const percent = votes / totalVotes;
              const sharePercent = (percent * 100).toFixed(2);
              
              // Curated high-contrast color palette, completely avoiding red and blue
              const colors = ['#10b981', '#f59e0b', '#8b5cf6', '#d946ef', '#14b8a6', '#eab308', '#84cc16', '#d97706', '#a78bfa', '#059669'];
              const color = colors[idx % colors.length];

              if (percent >= 0.9999) {
                // If a single candidate has 100% of the votes, draw a simple circle of radius 40
                svgHtml += `
                  <circle cx="50" cy="50" r="40" fill="${color}" class="pie-wedge">
                    <title>${cand}: ${votes.toLocaleString()} votes (${sharePercent}%)</title>
                  </circle>
                `;
                // Text overlay at center
                svgTextHtml += `
                  <text x="50" y="50" 
                        text-anchor="middle" dominant-baseline="middle" 
                        font-size="5" fill="#ffffff" font-weight="700" font-family="sans-serif"
                        style="paint-order: stroke fill; stroke: #000000; stroke-width: 0.8px; pointer-events: none;">
                    <tspan x="50" dy="-1.5">${cand}</tspan>
                    <tspan x="50" dy="4.5">${sharePercent}%</tspan>
                  </text>
                `;
              } else if (percent > 0) {
                const angle = percent * 2 * Math.PI;
                const endAngle = accumulatedAngle + angle;
                
                const x1 = 50 + 40 * Math.cos(accumulatedAngle);
                const y1 = 50 + 40 * Math.sin(accumulatedAngle);
                const x2 = 50 + 40 * Math.cos(endAngle);
                const y2 = 50 + 40 * Math.sin(endAngle);
                
                const largeArc = percent > 0.5 ? 1 : 0;
                
                // Wedge path meeting at center (50, 50)
                const pathData = `M 50 50 L ${x1.toFixed(4)} ${y1.toFixed(4)} A 40 40 0 ${largeArc} 1 ${x2.toFixed(4)} ${y2.toFixed(4)} Z`;
                
                svgHtml += `
                  <path d="${pathData}" fill="${color}" class="pie-wedge">
                    <title>${cand}: ${votes.toLocaleString()} votes (${sharePercent}%)</title>
                  </path>
                `;

                // Add text overlay if percent is at least 5% (to prevent cramped overlap)
                if (percent >= 0.05) {
                  const middleAngle = accumulatedAngle + angle / 2;
                  const r_text = 22; // Sweet spot radius inside the wedge
                  const tx = 50 + r_text * Math.cos(middleAngle);
                  const ty = 50 + r_text * Math.sin(middleAngle);

                  svgTextHtml += `
                    <text x="${tx.toFixed(4)}" y="${ty.toFixed(4)}" 
                          text-anchor="middle" dominant-baseline="middle" 
                          font-size="4.5" fill="#ffffff" font-weight="700" font-family="sans-serif"
                          style="paint-order: stroke fill; stroke: #000000; stroke-width: 0.8px; pointer-events: none;">
                      <tspan x="${tx.toFixed(4)}" dy="-1.5">${cand}</tspan>
                      <tspan x="${tx.toFixed(4)}" dy="4.5">${sharePercent}%</tspan>
                    </text>
                  `;
                }
                
                accumulatedAngle = endAngle;
              }

              // Legend Item
              legendHtml += `
                <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border-color);">
                  <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="width: 12px; height: 12px; border-radius: 50%; background-color: ${color}; display: inline-block;"></span>
                    <span class="text-semibold font-size-small">${cand}</span>
                  </div>
                  <div class="text-right">
                    <span class="text-semibold font-size-small">${votes.toLocaleString()}</span>
                    <span class="font-size-tiny text-muted nowrap" style="margin-left: 6px;">${sharePercent}%</span>
                  </div>
                </div>
              `;
            });

            svgEl.innerHTML = svgHtml + svgTextHtml;
            legendContainer.innerHTML = legendHtml;
          }
        }
      }
    },

    // Sort Helpers
    toggleSort: function(colName) {
      if (this.state.sortColumn === colName) {
        // Toggle back to default original CSV order on third click
        if (!this.state.sortAscending) {
          this.state.sortColumn = 'default';
          this.state.sortAscending = true;
        } else {
          this.state.sortAscending = false;
        }
      } else {
        this.state.sortColumn = colName;
        this.state.sortAscending = false; // default descending for numeric
      }
      this.render();
    },

    getSortIcon: function(colName) {
      if (this.state.sortColumn !== colName) return '&#x2195;'; // up-down arrow
      return this.state.sortAscending ? '&#x25B2;' : '&#x25BC;'; // up or down solid triangles
    },

    getAriaSort: function(colName) {
      if (this.state.sortColumn !== colName) return 'none';
      return this.state.sortAscending ? 'ascending' : 'descending';
    },

    // Search and Category Handlers
    handleSearchInput: function(event) {
      this.state.searchQuery = event.target.value;
      this.render();
    },

    setFilter: function(filterVal) {
      this.state.activeFilter = filterVal;
      
      // Update buttons active class & aria-pressed state
      const btns = document.querySelectorAll('.filter-btn');
      btns.forEach(btn => {
        const onclickAttr = btn.getAttribute('onclick');
        if (onclickAttr && onclickAttr.includes(`'${filterVal}'`)) {
          btn.classList.add('active');
          btn.setAttribute('aria-pressed', 'true');
        } else {
          btn.classList.remove('active');
          btn.setAttribute('aria-pressed', 'false');
        }
      });

      this.render();
    },

    handleContestChange: function(selector) {
      this.state.selectedContest = selector.value;
      
      // Update URL query parameters dynamically to preserve bookmarkable state and allow clean selection
      const url = new URL(window.location.href);
      url.searchParams.set('contest', selector.value);
      window.history.pushState({}, '', url.toString());

      this.render();
    },

    // 6. Accessible Precinct Group Modal Interactions
    openGroupsModal: function(event, precinctCode) {
      const dataStore = global.electionData;
      if (!dataStore) return;

      const precinct = dataStore.precincts[precinctCode];
      const activeContestName = this.state.selectedContest;
      
      if (!precinct || !activeContestName) return;

      // Track trigger element to restore focus on close (WCAG 2.1 AA)
      let trigger = event.currentTarget;
      if (trigger && trigger.tagName === 'TR') {
        const btn = trigger.querySelector('button');
        if (btn) trigger = btn;
      }
      this.state.focusedTriggerElement = trigger;

      const modalTitle = document.getElementById('modal-title');
      const modalBody = document.getElementById('modal-body-content');
      
      if (modalTitle) modalTitle.textContent = precinct.name + ' - Counting Groups';

      if (modalBody) {
        modalBody.innerHTML = '';
        
        let modalHtml = '';
        const groups = precinct.groups;
        
        if (Object.keys(groups).length === 0) {
          modalHtml = '<p class="text-center text-muted">No group breakdown available for this precinct.</p>';
        } else {
          const contest = dataStore.contests[activeContestName];
          const gOrderList = dataStore.groupsOrder || Object.keys(groups);

          // 1. Add Precinct General Turnout & Counting Group Breakdown Summary at the top
          const overallTurnoutShare = precinct.voters > 0 ? ((precinct.ballots.total / precinct.voters) * 100).toFixed(2) : '0.00';
          
          modalHtml += `
            <div style="background-color: var(--primary-light); padding: 16px; border-radius: var(--radius-md); margin-bottom: 24px; border: 1px solid var(--border-color);">
              <h4 class="font-size-small text-semibold" style="color: var(--primary); text-transform: uppercase; margin-bottom: 12px; border-bottom: 1px solid var(--border-color); padding-bottom: 6px; display: flex; align-items: center; gap: 6px;">
                &#x1F5F3;&#xFE0F; Precinct Turnout Summary
              </h4>
              <div class="group-result-row" style="padding: 6px 0;">
                <span class="group-name font-size-small" style="font-weight: 700;">Registered Voters</span>
                <span class="group-votes font-size-small" style="color: var(--text-main); font-weight: 700;">${precinct.voters.toLocaleString()}</span>
              </div>
              <div class="group-result-row" style="padding: 6px 0;">
                <span class="group-name font-size-small" style="font-weight: 700;">Total Ballots Cast (Turnout)</span>
                <span class="group-votes font-size-small" style="color: var(--text-main); font-weight: 700;">${precinct.ballots.total.toLocaleString()} (${overallTurnoutShare}%)</span>
              </div>
          `;

          gOrderList.forEach(groupName => {
            const groupData = groups[groupName];
            if (!groupData) return;
            const groupTurnoutShare = precinct.voters > 0 ? ((groupData.ballots.total / precinct.voters) * 100).toFixed(2) : '0.00';
            modalHtml += `
              <div class="group-result-row" style="padding: 6px 0; border-bottom: none !important;">
                <span class="group-name font-size-small" style="padding-left: 12px; color: var(--text-muted);">&bull; ${groupName} Ballots</span>
                <span class="group-votes font-size-small" style="color: var(--text-muted); font-weight: 500;">${groupData.ballots.total.toLocaleString()} (${groupTurnoutShare}%)</span>
              </div>
            `;
          });

          modalHtml += `
            </div>
          `;

          // 2. Pre-calculate total votes cast in this contest for each counting group in this precinct
          const contestGroupTotals = {};
          let totalContestPrecinctVotes = 0;
          const candidatePrecinctTotals = {};

          contest.candidates.forEach(c => {
            candidatePrecinctTotals[c] = 0;
          });

          gOrderList.forEach(groupName => {
            const groupData = groups[groupName];
            if (!groupData) return;
            
            let totalContestGroupVotes = 0;
            contest.candidates.forEach(c => {
              const v = groupData.results[activeContestName] ? (groupData.results[activeContestName][c] || 0) : 0;
              totalContestGroupVotes += v;
              candidatePrecinctTotals[c] += v;
            });
            contestGroupTotals[groupName] = totalContestGroupVotes;
            totalContestPrecinctVotes += totalContestGroupVotes;
          });

          // 3. Render candidates in strict CSV order
          contest.candidates.forEach(cand => {
            modalHtml += `
              <div style="margin-bottom: 24px !important; border-bottom: 1px solid var(--border-color) !important; padding-bottom: 16px !important;">
                <h4 class="font-size-small text-semibold" style="color: var(--primary) !important; margin-bottom: 12px !important; display: flex; align-items: center; gap: 6px;">
                  &#x1F464; ${cand}
                </h4>
            `;

            let candidateTotal = 0;
            const candTotal = candidatePrecinctTotals[cand] || 0;
            
            gOrderList.forEach(groupName => {
              const groupData = groups[groupName];
              if (!groupData) return;
              
              const votes = groupData.results[activeContestName] ? (groupData.results[activeContestName][cand] || 0) : 0;
              candidateTotal += votes;

              const sharePercent = candTotal > 0 ? ((votes / candTotal) * 100).toFixed(2) : '0.00';

              modalHtml += `
                <div class="group-result-row">
                  <span class="group-name font-size-small">${groupName}</span>
                  <span class="group-votes font-size-small">${votes.toLocaleString()} <span style="font-size: 11px; color: var(--text-muted); font-weight: 500; margin-left: 4px;">(${sharePercent}%)</span></span>
                </div>
              `;
            });

            const candidatePrecinctShare = totalContestPrecinctVotes > 0 ? ((candidateTotal / totalContestPrecinctVotes) * 100).toFixed(2) : '0.00';

            modalHtml += `
                <div class="group-result-row" style="border-top: 1px dashed var(--border-color) !important; padding-top: 8px !important; font-weight: 700 !important;">
                  <span class="group-name font-size-small">Total Calculated</span>
                  <span class="group-votes font-size-small" style="color: var(--text-main) !important;">${candidateTotal.toLocaleString()} <span style="font-size: 11px; color: var(--text-muted); font-weight: 500; margin-left: 4px;">(${candidatePrecinctShare}%)</span></span>
                </div>
              </div>
            `;
          });
        }
        
        modalBody.innerHTML = modalHtml;
      }

      // Show Modal
      const modal = document.getElementById('groups-modal');
      if (modal) {
        modal.classList.add('show');
        modal.style.display = 'flex';
        
        // Set inert on navigation and main elements to trap focus (WCAG 2.1 AA)
        const mainEl = document.getElementById('main-content');
        const navEl = document.querySelector('.navbar');
        if (mainEl) mainEl.setAttribute('inert', '');
        if (navEl) navEl.setAttribute('inert', '');
        
        // Focus the modal close button
        const closeBtn = document.getElementById('modal-close-button');
        if (closeBtn) closeBtn.focus();
      }
    },

    closeGroupsModal: function() {
      const modal = document.getElementById('groups-modal');
      if (modal) {
        modal.classList.remove('show');
        modal.style.display = 'none';
      }

      // Remove inert from navigation and main elements (WCAG 2.1 AA)
      const mainEl = document.getElementById('main-content');
      const navEl = document.querySelector('.navbar');
      if (mainEl) mainEl.removeAttribute('inert');
      if (navEl) navEl.removeAttribute('inert');

      // Restore focus to original trigger element (WCAG AA)
      if (this.state.focusedTriggerElement) {
        this.state.focusedTriggerElement.focus();
        this.state.focusedTriggerElement = null;
      }
    },

    handleModalKey: function(event) {
      if (event.key === 'Escape') {
        this.closeGroupsModal();
      }
    },

    // 7. Add-to-Calendar Functionality & 3-Tier Fallback Trigger
    toggleCalendarMenu: function(event, menuId) {
      event.stopPropagation();
      const menu = document.getElementById(menuId);
      const isShowing = menu.classList.contains('show');
      
      const allMenus = document.querySelectorAll('.calendar-menu');
      allMenus.forEach(m => m.classList.remove('show'));

      if (!isShowing) {
        menu.classList.add('show');
        event.currentTarget.setAttribute('aria-expanded', 'true');
      } else {
        event.currentTarget.setAttribute('aria-expanded', 'false');
      }
    },

    handleCalendarKey: function(event, menuId) {
      if (event.key === 'Escape') {
        const menu = document.getElementById(menuId);
        if (menu && menu.classList.contains('show')) {
          menu.classList.remove('show');
          const trigger = document.getElementById(menuId + '-btn');
          if (trigger) {
            trigger.setAttribute('aria-expanded', 'false');
            trigger.focus();
          }
        }
      }
    },

    downloadICS: function(title, start, end, details, location, filename) {
      const uid = 'hcec-' + Date.now() + '@elect.hamiltontn.gov';
      const dtstamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      
      const payload = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//HamiltonCounty//Election//EN',
        'BEGIN:VEVENT',
        'UID:' + uid,
        'DTSTAMP:' + dtstamp,
        'DTSTART:' + start,
        'DTEND:' + end,
        'SUMMARY:' + title,
        'DESCRIPTION:' + details,
        'LOCATION:' + location,
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n');

      const dataUri = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(payload);
      
      const link = document.createElement('a');
      link.href = dataUri;
      link.setAttribute('download', filename || 'event.ics');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },

    // 8. Refinement: Client-Side "Export to CSV" Utility
    exportToCSV: function() {
      const dataStore = global.electionData;
      if (!dataStore) return;

      const activeContestName = this.state.selectedContest;
      const contest = dataStore.contests[activeContestName];
      if (!contest) return;

      // Setup Headers
      const headers = ["Precinct Code", "Precinct Name", "Registered Voters", "Ballots Cast Total", "Turnout %"];
      contest.candidates.forEach(cand => {
        headers.push(cand);
      });

      // Escape headers
      const csvRows = [headers.map(h => `"${h.replace(/"/g, '""')}"`).join(",")];

      // Grab precinct rows in active display list
      let precinctsList = [];
      const pOrderList = dataStore.precinctsOrder || Object.keys(dataStore.precincts);
      
      pOrderList.forEach(code => {
        const p = dataStore.precincts[code];
        if (!p) return;
        
        // Filter by Query
        if (this.state.searchQuery) {
          const q = this.state.searchQuery.toLowerCase();
          const matchCode = p.code.toLowerCase().includes(q);
          const matchName = p.name.toLowerCase().includes(q);
          if (!matchCode && !matchName) return;
        }

        // Suppress precinct if all candidates in this contest have 0 votes
        let hasVotes = false;
        contest.candidates.forEach(cand => {
          const votes = p.results[activeContestName] ? (p.results[activeContestName][cand] || 0) : 0;
          if (votes > 0) {
            hasVotes = true;
          }
        });
        if (!hasVotes) return;

        precinctsList.push(p);
      });

      // Handle active column sorting
      if (this.state.sortColumn !== 'default') {
        precinctsList.sort((a, b) => {
          let valA, valB;
          if (this.state.sortColumn === 'precinct') {
            valA = a.name.toUpperCase();
            valB = b.name.toUpperCase();
          } else if (this.state.sortColumn === 'voters') {
            valA = a.voters;
            valB = b.voters;
          } else if (this.state.sortColumn === 'ballots') {
            valA = a.voters > 0 ? (a.ballots.total / a.voters) : 0;
            valB = b.voters > 0 ? (b.ballots.total / b.voters) : 0;
          } else {
            valA = a.results[activeContestName] ? (a.results[activeContestName][this.state.sortColumn] || 0) : 0;
            valB = b.results[activeContestName] ? (b.results[activeContestName][this.state.sortColumn] || 0) : 0;
          }
          if (valA < valB) return this.state.sortAscending ? -1 : 1;
          if (valA > valB) return this.state.sortAscending ? 1 : -1;
          return 0;
        });
      }

      // Add Precinct Rows
      precinctsList.forEach(p => {
        const turnoutPercent = p.voters > 0 ? ((p.ballots.total / p.voters) * 100).toFixed(2) : '0.00';
        const row = [
          `"${p.code}"`,
          `"${p.name.replace(/"/g, '""')}"`,
          p.voters,
          p.ballots.total,
          `"${turnoutPercent}%"`
        ];
        contest.candidates.forEach(cand => {
          const votes = p.results[activeContestName] ? (p.results[activeContestName][cand] || 0) : 0;
          row.push(votes);
        });
        csvRows.push(row.join(","));
      });

      // Add County Totals Row
      const countyTotalTurnout = dataStore.countySummary.voters > 0 
        ? ((dataStore.countySummary.ballots.total / dataStore.countySummary.voters) * 100).toFixed(2) 
        : '0.00';
      
      const totalRow = [
        `"ZZZ"`,
        `"COUNTY TOTALS"`,
        dataStore.countySummary.voters,
        dataStore.countySummary.ballots.total,
        `"${countyTotalTurnout}%"`
      ];
      contest.candidates.forEach(cand => {
        const votes = contest.countyTotals[cand] || 0;
        totalRow.push(votes);
      });
      csvRows.push(totalRow.join(","));

      // Download trigger
      const csvString = csvRows.join("\n");
      const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement("a");
      link.href = url;
      const safeContestName = activeContestName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
      link.setAttribute("download", `hcec_precinct_results_${safeContestName}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },

    // 9. Refinement: Client-Side "Download Master CSV" Utility (All Contests, Skips Write-ins)
    downloadMasterCSV: function() {
      const dataStore = global.electionData;
      if (!dataStore) return;

      // Compile master headers across all contests
      const contestHeaders1 = ["", "", "", "", "", ""]; 
      const partyHeaders2 = ["", "", "", "", "", ""];   
      const candidateHeaders3 = [
        "Precinct Code", "Precinct Name", "Registered Voters", 
        "Ballots Cast Total", "Ballots Cast - Republican", "Ballots Cast - Democratic"
      ]; 

      const contestOrderList = dataStore.contestsOrder || Object.keys(dataStore.contests);
      const columnMappings = []; 

      contestOrderList.forEach(contestName => {
        const contest = dataStore.contests[contestName];
        if (!contest) return;

        contest.candidates.forEach(cand => {
          contestHeaders1.push(contestName);
          partyHeaders2.push(contest.party);
          candidateHeaders3.push(cand);
          columnMappings.push({ contestName, candidate: cand });
        });
      });

      const csvRows = [];
      csvRows.push(contestHeaders1.map(h => `"${h.replace(/"/g, '""')}"`).join(","));
      csvRows.push(partyHeaders2.map(h => `"${h.replace(/"/g, '""')}"`).join(","));
      csvRows.push(candidateHeaders3.map(h => `"${h.replace(/"/g, '""')}"`).join(","));

      // Add Precinct Rows in exact CSV order
      const pOrderList = dataStore.precinctsOrder || Object.keys(dataStore.precincts);
      pOrderList.forEach(code => {
        const p = dataStore.precincts[code];
        if (!p) return;

        const row = [
          `"${p.code}"`,
          `"${p.name.replace(/"/g, '""')}"`,
          p.voters,
          p.ballots.total,
          p.ballots.rep,
          p.ballots.dem
        ];

        columnMappings.forEach(mapping => {
          const votes = p.results[mapping.contestName] ? (p.results[mapping.contestName][mapping.candidate] || 0) : 0;
          row.push(votes);
        });
        csvRows.push(row.join(","));
      });

      // Add County Totals Row
      const totalRow = [
        `"ZZZ"`,
        `"COUNTY TOTALS"`,
        dataStore.countySummary.voters,
        dataStore.countySummary.ballots.total,
        dataStore.countySummary.ballots.rep,
        dataStore.countySummary.ballots.dem
      ];

      columnMappings.forEach(mapping => {
        const contest = dataStore.contests[mapping.contestName];
        const votes = contest ? (contest.countyTotals[mapping.candidate] || 0) : 0;
        totalRow.push(votes);
      });
      csvRows.push(totalRow.join(","));

      // Download trigger
      const csvString = csvRows.join("\n");
      const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", "hamilton_county_primary_official_results_master.csv");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    },

    downloadMasterCSVWithGroups: function() {
      const dataStore = global.electionData;
      if (!dataStore) return;

      // Compile master headers across all contests
      const contestHeaders1 = ["", "", "", "", "", "", ""]; 
      const partyHeaders2 = ["", "", "", "", "", "", ""];   
      const candidateHeaders3 = [
        "Counting Group", "Precinct Code", "Precinct Name", "Registered Voters", 
        "Ballots Cast Total", "Ballots Cast - Republican", "Ballots Cast - Democratic"
      ]; 

      const contestOrderList = dataStore.contestsOrder || Object.keys(dataStore.contests);
      const columnMappings = []; 

      contestOrderList.forEach(contestName => {
        const contest = dataStore.contests[contestName];
        if (!contest) return;

        contest.candidates.forEach(cand => {
          contestHeaders1.push(contestName);
          partyHeaders2.push(contest.party);
          candidateHeaders3.push(cand);
          columnMappings.push({ contestName, candidate: cand });
        });
      });

      const csvRows = [];
      csvRows.push(contestHeaders1.map(h => `"${h.replace(/"/g, '""')}"`).join(","));
      csvRows.push(partyHeaders2.map(h => `"${h.replace(/"/g, '""')}"`).join(","));
      csvRows.push(candidateHeaders3.map(h => `"${h.replace(/"/g, '""')}"`).join(","));

      // Set up counting group totals collector for county-wide summary
      const groupTotals = {};

      // Add Precinct Group rows in exact CSV order
      const pOrderList = dataStore.precinctsOrder || Object.keys(dataStore.precincts);
      pOrderList.forEach(code => {
        const p = dataStore.precincts[code];
        if (!p) return;

        const gOrderList = dataStore.groupsOrder || Object.keys(p.groups);
        gOrderList.forEach(groupName => {
          const g = p.groups[groupName];
          if (!g) return;

          // Collect group totals
          if (!groupTotals[groupName]) {
            groupTotals[groupName] = {
              ballots: { total: 0, rep: 0, dem: 0 },
              results: {}
            };
          }
          groupTotals[groupName].ballots.total += g.ballots.total;
          groupTotals[groupName].ballots.rep += g.ballots.rep;
          groupTotals[groupName].ballots.dem += g.ballots.dem;

          const row = [
            `"${groupName.replace(/"/g, '""')}"`,
            `"${p.code}"`,
            `"${p.name.replace(/"/g, '""')}"`,
            `""`, // Registered voters empty for group splits
            g.ballots.total,
            g.ballots.rep,
            g.ballots.dem
          ];

          columnMappings.forEach(mapping => {
            const votes = g.results[mapping.contestName] ? (g.results[mapping.contestName][mapping.candidate] || 0) : 0;
            row.push(votes);

            // Accumulate candidate totals for the group
            if (!groupTotals[groupName].results[mapping.contestName]) {
              groupTotals[groupName].results[mapping.contestName] = {};
            }
            groupTotals[groupName].results[mapping.contestName][mapping.candidate] = 
              (groupTotals[groupName].results[mapping.contestName][mapping.candidate] || 0) + votes;
          });

          csvRows.push(row.join(","));
        });
      });

      // Add County Totals broken down by Counting Group
      const gOrderList = dataStore.groupsOrder || Object.keys(groupTotals);
      gOrderList.forEach(groupName => {
        const gt = groupTotals[groupName];
        if (!gt) return;

        const totalRow = [
          `"${groupName.replace(/"/g, '""')}"`,
          `"ZZZ"`,
          `"COUNTY TOTALS"`,
          `""`, // Registered voters empty for group splits
          gt.ballots.total,
          gt.ballots.rep,
          gt.ballots.dem
        ];

        columnMappings.forEach(mapping => {
          const votes = gt.results[mapping.contestName] ? (gt.results[mapping.contestName][mapping.candidate] || 0) : 0;
          totalRow.push(votes);
        });

        csvRows.push(totalRow.join(","));
      });

      // Add overall Grand County Totals row
      const grandTotalRow = [
        `"TOTALS"`,
        `"ZZZ"`,
        `"COUNTY TOTALS"`,
        dataStore.countySummary.voters,
        dataStore.countySummary.ballots.total,
        dataStore.countySummary.ballots.rep,
        dataStore.countySummary.ballots.dem
      ];

      columnMappings.forEach(mapping => {
        const contest = dataStore.contests[mapping.contestName];
        const votes = contest ? (contest.countyTotals[mapping.candidate] || 0) : 0;
        grandTotalRow.push(votes);
      });
      csvRows.push(grandTotalRow.join(","));

      // Download trigger
      const csvString = csvRows.join("\n");
      const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", "hamilton_county_primary_official_results_master_with_groups.csv");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  // Close calendar menus on page click
  document.addEventListener('click', function() {
    const allMenus = document.querySelectorAll('.calendar-menu');
    allMenus.forEach(m => m.classList.remove('show'));
    const allBtns = document.querySelectorAll('.calendar-dropdown-wrapper button');
    allBtns.forEach(b => b.setAttribute('aria-expanded', 'false'));
  });

  // Export to global namespace
  global.ElectionApp = ElectionApp;

  // Robust Autostart (checks if DOM is already interactive/complete)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      ElectionApp.init();
    });
  } else {
    ElectionApp.init();
  }

})(window);
