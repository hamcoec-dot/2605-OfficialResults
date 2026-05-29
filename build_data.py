# ==========================================================================
# Hamilton County Election Commission - Election Data Bundler (Python 3)
# Created: May 2026
# Audited/Refined: May 29, 2026 (WCAG 2.1 AA, Mobile Card-Folding, & Timing Audits)
# Purpose: Compiles raw CSVs into a static assets/data.js file for public hosting.
# Refinement: Excludes Write-in candidates, preserves CSV order, robust for future datasets.
# Idempotent: Auto-creates output directories and safely overwrites previous static assets.
# ==========================================================================

import csv
import json
import os

def read_csv_robust(file_path):
    """
    Robust reader that strips UTF-8 BOM automatically and falls back to cp1252
    if the CSV contains legacy Windows encoding characters.
    """
    try:
        with open(file_path, 'r', encoding='utf-8-sig') as f:
            return list(csv.reader(f))
    except UnicodeDecodeError:
        with open(file_path, 'r', encoding='cp1252') as f:
            return list(csv.reader(f))

def build_data():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(base_dir, 'data')
    output_js_path = os.path.join(base_dir, 'assets', 'data.js')

    # Ensure output asset directory exists to secure absolute idempotency
    output_dir = os.path.dirname(output_js_path)
    if not os.path.exists(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    # Dynamic file scanning to handle future named election datasets
    no_groups_path = None
    groups_path = None

    if os.path.exists(data_dir):
        for file in os.listdir(data_dir):
            file_upper = file.upper()
            if file_upper.endswith('.CSV'):
                if 'NO GROUPS' in file_upper or 'WITHOUT GROUPS' in file_upper:
                    no_groups_path = os.path.join(data_dir, file)
                elif 'WITH GROUPS' in file_upper:
                    groups_path = os.path.join(data_dir, file)

    # Fallback to default filenames if dynamic scanning did not identify them
    if not no_groups_path:
        no_groups_path = os.path.join(data_dir, '2026-05-05 - County Primary - Export with No Groups.CSV')
    if not groups_path:
        groups_path = os.path.join(data_dir, '2026-05-05 - County Primary - Export with Groups.CSV')

    print(f"Loading No Groups CSV: {no_groups_path}")
    print(f"Loading With Groups CSV: {groups_path}")

    if not os.path.exists(no_groups_path):
        raise FileNotFoundError(f"Missing required data file: {no_groups_path}")
    if not os.path.exists(groups_path):
        raise FileNotFoundError(f"Missing required data file: {groups_path}")

    # Initialize standard database structure
    data_store = {
        'precincts': {},
        'contests': {},
        'contestsOrder': [],
        'precinctsOrder': [],
        'groupsOrder': [],
        'countySummary': {
            'voters': 0,
            'ballots': {'total': 0, 'rep': 0, 'dem': 0}
        }
    }

    # 1. Parse "Export with No Groups" CSV
    reader = read_csv_robust(no_groups_path)

    if len(reader) < 4:
        raise ValueError("Invalid CSV format. File contains insufficient data rows.")

    contests_row = reader[0]
    parties_row = reader[1]
    candidates_row = reader[2]
    contest_start_idx = 7

    # Setup contests metadata in exact column order
    for col in range(contest_start_idx, len(contests_row)):
        contest_name = contests_row[col].strip()
        
        # General Election / Non-Partisan fallback support
        raw_party = parties_row[col].strip() if col < len(parties_row) else ""
        party_name = raw_party if raw_party else "NON"
        
        candidate_name = candidates_row[col].strip()

        if not contest_name or not candidate_name:
            continue
            
        # Completely omit Write-in results from all views
        if candidate_name == "Write-in":
            continue

        if contest_name not in data_store['contestsOrder']:
            data_store['contestsOrder'].append(contest_name)

        if contest_name not in data_store['contests']:
            data_store['contests'][contest_name] = {
                'name': contest_name,
                'party': party_name,
                'candidates': [],
                'columns': [] # Temporary columns metadata for coordinate parsing
            }

        # Keep candidates list in exact CSV columns order (left-to-right)
        if candidate_name not in data_store['contests'][contest_name]['candidates']:
            data_store['contests'][contest_name]['candidates'].append(candidate_name)

        data_store['contests'][contest_name]['columns'].append({
            'index': col,
            'candidate': candidate_name
        })

    # Process Precinct data rows in exact CSV order (top-to-bottom)
    for r in range(3, len(reader)):
        row = reader[r]
        if len(row) < 5:
            continue

        raw_code = row[1].strip()
        precinct_name = row[2].strip()

        if not raw_code or not precinct_name:
            continue

        # Zero-pad precinct code to 4 digits (e.g. "1" -> "0001") for robust comparison
        precinct_code = raw_code.zfill(4)
        registered_voters = int(row[3]) if row[3] else 0
        ballots_total = int(row[4]) if row[4] else 0
        ballots_rep = int(row[5]) if row[5] else 0
        ballots_dem = int(row[6]) if row[6] else 0

        # Robust totals row detection covering ZZZ, ZZZZ, 0ZZZ, or COUNTY TOTALS
        if precinct_code in ["0ZZZ", "ZZZZ", "00ZZZ", "ZZZ"] or "TOTALS" in precinct_name.upper():
            data_store['countySummary']['voters'] = registered_voters
            data_store['countySummary']['ballots']['total'] = ballots_total
            data_store['countySummary']['ballots']['rep'] = ballots_rep
            data_store['countySummary']['ballots']['dem'] = ballots_dem

            # Fill county totals for candidates
            for contest_name, contest in data_store['contests'].items():
                contest['countyTotals'] = {}
                for col_mapping in contest['columns']:
                    votes = int(row[col_mapping['index']]) if row[col_mapping['index']] else 0
                    cand = col_mapping['candidate']
                    contest['countyTotals'][cand] = contest['countyTotals'].get(cand, 0) + votes
            continue

        # Track precinct top-to-bottom CSV row order
        if precinct_code not in data_store['precinctsOrder']:
            data_store['precinctsOrder'].append(precinct_code)

        # Setup standard precinct record
        precinct_record = {
            'code': precinct_code,
            'name': precinct_name,
            'voters': registered_voters,
            'ballots': {
                'total': ballots_total,
                'rep': ballots_rep,
                'dem': ballots_dem
            },
            'results': {},
            'groups': {}
        }

        # Populate precinct results
        for contest_name, contest in data_store['contests'].items():
            precinct_record['results'][contest_name] = {}
            for col_mapping in contest['columns']:
                votes = int(row[col_mapping['index']]) if row[col_mapping['index']] else 0
                precinct_record['results'][contest_name][col_mapping['candidate']] = votes

        data_store['precincts'][precinct_code] = precinct_record

    # 2. Parse "Export with Groups" CSV and integrate breakdown splits
    groups_reader = read_csv_robust(groups_path)

    g_contests_row = groups_reader[0]
    g_candidates_row = groups_reader[2]

    # Process group splits and capture counting groups exact row order
    for r in range(3, len(groups_reader)):
        row = groups_reader[r]
        if len(row) < 5:
            continue

        group_name = row[0].strip()
        raw_code = row[1].strip()
        precinct_name = row[2].strip()

        if not group_name or not raw_code or not precinct_name:
            continue
        
        # Omit summary rows inside group file
        if "TOTALS" in precinct_name.upper() or raw_code.upper() in ["ZZZ", "ZZZZ", "0ZZZ"]:
            continue

        # Track groups top-to-bottom CSV row order
        if group_name not in data_store['groupsOrder']:
            data_store['groupsOrder'].append(group_name)

        precinct_code = raw_code.zfill(4)
        precinct = data_store['precincts'].get(precinct_code)

        if not precinct:
            continue

        ballots_total = int(row[4]) if row[4] else 0
        ballots_rep = int(row[5]) if row[5] else 0
        ballots_dem = int(row[6]) if row[6] else 0

        # Initialize group under precinct
        if group_name not in precinct['groups']:
            precinct['groups'][group_name] = {
                'name': group_name,
                'ballots': {
                    'total': ballots_total,
                    'rep': ballots_rep,
                    'dem': ballots_dem
                },
                'results': {}
            }

        # Map candidate splits inside group (skip Write-ins)
        for col in range(contest_start_idx, len(row)):
            if col >= len(g_contests_row) or col >= len(g_candidates_row):
                continue
            contest_name = g_contests_row[col].strip()
            candidate_name = g_candidates_row[col].strip()
            votes = int(row[col]) if row[col] else 0

            if not contest_name or not candidate_name:
                continue
            if candidate_name == "Write-in":
                continue

            if contest_name in data_store['contests']:
                if contest_name not in precinct['groups'][group_name]['results']:
                    precinct['groups'][group_name]['results'][contest_name] = {}
                precinct['groups'][group_name]['results'][contest_name][candidate_name] = votes

    # Tag contests with isNoCandidateQualified flag for presentation rendering
    for contest in data_store['contests'].values():
        is_no_cand = len(contest['candidates']) == 1 and contest['candidates'][0] == 'No Candidate Qualified'
        contest['isNoCandidateQualified'] = is_no_cand

    # Cleanup temp 'columns' metadata list from contests before outputting JSON
    for contest in data_store['contests'].values():
        if 'columns' in contest:
            del contest['columns']

    # 3. Write out to assets/data.js
    print(f"Compiling statically to: {output_js_path}")
    json_data = json.dumps(data_store, indent=2)
    js_content = f"/* ==========================================================================\n" \
                 f"   Hamilton County Election Commission - Compiled Results Data\n" \
                 f"   Generated: May 2026\n" \
                 f"   Purpose: Static dataset for instant serverless execution.\n" \
                 f"   ========================================================================== */\n\n" \
                 f"window.electionData = {json_data};\n"

    with open(output_js_path, 'w', encoding='utf-8') as f:
        f.write(js_content)

    print("Success! Data bundle compiled successfully and is ready for offline distribution.")

if __name__ == '__main__':
    build_data()
