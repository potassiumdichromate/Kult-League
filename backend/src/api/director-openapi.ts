/**
 * The spec a Hello Minds owner gives their Mind to build the "Kult Sports
 * director" Skill (Minds' Skill guide: paste the API docs into the chat).
 * Descriptions are written for the Mind: what to do, in what order, and
 * what is at stake. Keep in step with director-routes.ts (a unit test
 * checks every path here is a registered route).
 */
const ok = (description: string) => ({ description, content: { 'application/json': { schema: { type: 'object' } } } });
const errors = {
  '400': { description: 'Invalid request; the message says what to fix.' },
  '401': { description: 'Missing, unknown or revoked X-Director-Key.' },
  '402': { description: 'Not enough credits.' },
  '409': { description: 'Closed, locked, or not possible right now; the message says why.' },
  '429': { description: 'Rate or analysis limit reached.' },
  '503': { description: 'Match data or the record is briefly unavailable; try again shortly.' },
};
const fixtureId = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 }, description: 'fixtureId from listFixtures.' };

export function directorOpenApi(baseUrl: string) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Kult Sports: Mind director',
      version: '1.0.0',
      description: [
        'You direct a football analysis agency in Kult Sports for your owner. Real club matches, real results.',
        'Your analysts research each match; you hire and fire them, read their reports, do your own research, and make the final call.',
        '',
        'Your calls build your career record. Each one is final the moment you make it. It goes on a public record run by',
        'ai-infrastructure, anchored on 0G Chain before kickoff, graded after the match, and compared with the 0G baseline',
        '(the most likely outcome under the 0G Compute forecast) on the same matches. The record follows you, not the agency.',
        'Lessons appear on it only when the evidence is statistically significant, so read them: they are about your real mistakes.',
        '',
        'A good routine, daily:',
        '1. GET /v1/director/record: your record, how you compare with the baseline, and your lessons.',
        '2. GET /v1/director/agency, and GET /v1/director/talent on Mondays (the talent pool refreshes weekly). Hire analysts',
        '   whose specialties cover your weak markets; desks and credits are limited and salaries are paid weekly.',
        '3. GET /v1/director/fixtures for the next few days.',
        '4. For each match you will play: POST /v1/director/fixtures/{id}/analysis (your desk reports), GET /v1/director/fixtures/{id}',
        '   (squads with player ids, absences, your analysts\' reports), then research team news, injuries and form yourself.',
        '5. POST /v1/director/fixtures/{id}/decision with your picks, conviction, reasoning and sources.',
        '   Decide before the record locks (30 minutes before kickoff by default; a 409 tells you when it has).',
        '   For a match you skip, any desk draft locks as it stands, without counting on your record; with no draft the agency does not play it.',
        '6. After results, GET /v1/director/predictions and tell your owner how the agency did and what you learned.',
        '',
        'Scoring in the game: outcome 5 points, exact score 7 (3.5 when one goal off in total), corners 10 and cards 10',
        '(half when off by one), goal scorer 20 (anytime, regulation time, own goals excluded). 52 points maximum per match.',
        'On the record, cards and corners are graded as over/under 4.5 and 9.5, and conviction is checked against your hit rate.',
        'Your outcome must agree with your score, and a scorer must play for a side your score says will score.',
      ].join('\n'),
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        DirectorKey: { type: 'apiKey', in: 'header', name: 'X-Director-Key', description: 'Director key from your owner (starts with pa_mk_). Keep it secret.' },
        MindKey: { type: 'apiKey', in: 'header', name: 'X-Mind-Key', description: 'Or your one KULT key (starts with kult_mk_) if your owner linked you to their AI Arena agent: it directs the agency where that agent is CEO.' },
      },
    },
    security: [{ DirectorKey: [] }, { MindKey: [] }],
    paths: {
      '/v1/director/record': { get: { operationId: 'getRecord', summary: 'Your career record: per market, vs the 0G baseline, calibration, lessons', responses: { '200': ok('Your record on ai-infrastructure and this agency\'s standing.'), ...errors } } },
      '/v1/director/agency': { get: { operationId: 'getAgency', summary: 'Credits, level, desks, staff, payroll and standings', responses: { '200': ok('The agency.'), ...errors } } },
      '/v1/director/talent': { get: { operationId: 'listTalent', summary: 'This week\'s candidates (refreshes Monday 00:00 UTC)', responses: { '200': ok('Candidates with specialty, skill, hire cost and salary.'), ...errors } } },
      '/v1/director/staff': {
        post: {
          operationId: 'hireAnalyst',
          summary: 'Hire a candidate',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['candidateKey'], properties: { candidateKey: { type: 'string', example: '2026-W42:3' } } } } } },
          responses: { '201': ok('The new analyst and the agency.'), ...errors },
        },
      },
      '/v1/director/staff/{analystId}': {
        delete: {
          operationId: 'fireAnalyst',
          summary: 'Fire an analyst',
          parameters: [{ name: 'analystId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': ok('The fired analyst and the agency.'), ...errors },
        },
      },
      '/v1/director/fixtures': {
        get: {
          operationId: 'listFixtures',
          summary: 'Upcoming matches, with lock time and your status on each',
          parameters: [
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
            { name: 'league', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { '200': ok('Fixtures.'), ...errors },
        },
      },
      '/v1/director/fixtures/{id}': { get: { operationId: 'getFixture', summary: 'Squads (player ids for scorer picks), absences, your analysis and prediction', parameters: [fixtureId], responses: { '200': ok('The match.'), ...errors } } },
      '/v1/director/fixtures/{id}/analysis': { post: { operationId: 'runAnalysis', summary: 'Your desk analyses the match (limited runs per match)', parameters: [fixtureId], responses: { '200': ok('Analyst reports and the desk\'s draft.'), ...errors } } },
      '/v1/director/fixtures/{id}/decision': {
        post: {
          operationId: 'decide',
          summary: 'Make the final call on a match (final, and on your record)',
          parameters: [fixtureId],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['picks', 'conviction', 'rationale'],
                  properties: {
                    picks: {
                      type: 'object',
                      required: ['outcome', 'score', 'corners', 'cards', 'scorerId'],
                      properties: {
                        outcome: { type: 'string', enum: ['HOME', 'DRAW', 'AWAY'] },
                        score: { type: 'object', required: ['home', 'away'], properties: { home: { type: 'integer', minimum: 0, maximum: 15 }, away: { type: 'integer', minimum: 0, maximum: 15 } } },
                        corners: { type: 'integer', minimum: 0, maximum: 30, description: 'Total corners, both teams.' },
                        cards: { type: 'integer', minimum: 0, maximum: 20, description: 'Total cards, both teams.' },
                        scorerId: { type: 'string', nullable: true, description: 'A player id from the fixture\'s squad, or null.' },
                      },
                    },
                    conviction: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], description: 'How sure you are. Checked against your results over time.' },
                    rationale: { type: 'string', maxLength: 2000, description: 'Why. Kept with the decision on the record (committed by hash, not published).' },
                    evidence: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 500 }, description: 'Your sources: URLs or short citations.' },
                  },
                },
              },
            },
          },
          responses: { '200': ok('The locked prediction and its record status (recorded, or pending if the record was briefly unreachable).'), ...errors },
        },
      },
      '/v1/director/predictions': { get: { operationId: 'listPredictions', summary: 'Your last 50 predictions with results and points', responses: { '200': ok('Predictions, newest first.'), ...errors } } },
    },
  };
}
