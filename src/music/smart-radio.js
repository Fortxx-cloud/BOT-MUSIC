import { readFile, writeFile, rename } from 'node:fs/promises';

const HISTORY_FILE = new URL('../../smart-radio-history.json', import.meta.url);

const HISTORY_LIMIT = 60;
const RECENT_LIMIT = 25;
const MIN_SCORE = 48;
const SEARCH_TIMEOUT = 12000;

let historyCache = null;
let writeQueue = Promise.resolve();

const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'you', 'your', 'this',
    'that', 'from', 'are', 'was', 'yang', 'dan', 'di',
    'ke', 'dari', 'aku', 'kau', 'kamu', 'ku', 'mu',
    'official', 'video', 'audio', 'lyrics', 'lyric',
    'music', 'visualizer', 'mv', 'hd', '4k'
]);

const LANGUAGE_MARKERS = {
    id: new Set([
        'cinta', 'sayang', 'hati', 'rindu', 'aku', 'kamu',
        'dirimu', 'kasih', 'jangan', 'bukan', 'sudah',
        'belum', 'untuk', 'dengan', 'tak', 'ingin',
        'selalu', 'pernah', 'yang', 'bila', 'sampai',
        'ku', 'mengapa', 'kenapa', 'terluka'
    ]),
    en: new Set([
        'love', 'baby', 'heart', 'never', 'forever',
        'tonight', 'tonight', 'lonely', 'beautiful',
        'believe', 'feeling', 'feel', 'wanna', 'gonna',
        'without', 'someone', 'everything', 'nothing',
        'world', 'dream', 'stay', 'together', 'broken'
    ])
};

const GENRES = {
    pop: ['pop', 'populer', 'pop music'],
    rock: ['rock', 'metal', 'punk', 'hard rock'],
    dangdut: ['dangdut', 'koplo', 'pantura', 'tarling'],
    edm: ['edm', 'electronic', 'techno', 'house', 'trance', 'remix'],
    hiphop: ['hip hop', 'hip-hop', 'rap', 'trap'],
    rnb: ['r&b', 'rnb', 'soul'],
    indie: ['indie', 'folk', 'acoustic', 'akustik'],
    kpop: ['k-pop', 'kpop'],
    jazz: ['jazz', 'blues'],
    reggae: ['reggae', 'ska']
};

const MOODS = {
    sad: [
        'galau', 'sedih', 'patah hati', 'menangis',
        'terluka', 'sad', 'lonely', 'heartbreak',
        'broken heart', 'crying', 'goodbye',
        'sakiti', 'kecewa', 'kehilangan'
    ],
    romantic: [
        'cinta', 'sayang', 'love', 'kasih', 'romantic',
        'forever', 'wedding', 'rindu', 'jatuh cinta',
        'fall in love'
    ],
    happy: [
        'happy', 'bahagia', 'senang', 'ceria',
        'party', 'fun', 'smile', 'good vibes'
    ],
    chill: [
        'chill', 'santai', 'relax', 'mellow',
        'acoustic', 'lofi', 'lo-fi', 'slow'
    ],
    energetic: [
        'workout', 'hype', 'dance', 'remix',
        'edm', 'energy', 'power', 'festival'
    ]
};

function normalize(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function trackKey(track) {
    const info = track?.info || {};
    return String(
        info.identifier ||
        info.uri ||
        `${info.title || ''}|${info.author || ''}`
    ).toLowerCase();
}

function getTrackText(track) {
    const info = track?.info || {};

    return normalize([
        info.title,
        info.author,
        info.genre,
        info.language
    ].filter(Boolean).join(' '));
}

function tokenize(value) {
    return new Set(
        normalize(value)
            .split(' ')
            .filter(word => word.length > 2 && !STOP_WORDS.has(word))
    );
}

function similarity(a, b) {
    const first = tokenize(a);
    const second = tokenize(b);

    if (!first.size || !second.size) return 0;

    let intersection = 0;

    for (const word of first) {
        if (second.has(word)) intersection++;
    }

    return intersection / new Set([...first, ...second]).size;
}

function detectLanguage(track) {
    const info = track?.info || {};

    const explicit = normalize(
        info.language || track?.pluginInfo?.language || ''
    );

    if (['indonesian', 'bahasa indonesia', 'id'].includes(explicit)) {
        return { code: 'id', confidence: 3 };
    }

    if (['english', 'en'].includes(explicit)) {
        return { code: 'en', confidence: 3 };
    }

    const words = tokenize(getTrackText(track));
    const scores = { id: 0, en: 0 };

    for (const word of words) {
        if (LANGUAGE_MARKERS.id.has(word)) scores.id++;
        if (LANGUAGE_MARKERS.en.has(word)) scores.en++;
    }

    if (scores.id >= 2 && scores.id > scores.en) {
        return { code: 'id', confidence: scores.id };
    }

    if (scores.en >= 2 && scores.en > scores.id) {
        return { code: 'en', confidence: scores.en };
    }

    return { code: 'unknown', confidence: 0 };
}

function detectTags(track, dictionary) {
    const text = getTrackText(track);
    const tags = [];

    for (const [tag, keywords] of Object.entries(dictionary)) {
        if (keywords.some(keyword => text.includes(normalize(keyword)))) {
            tags.push(tag);
        }
    }

    return tags;
}

function getPopularity(track) {
    const info = track?.info || {};
    const possibleKeys = [
        'viewCount', 'views', 'playCount',
        'plays', 'popularity'
    ];

    const objects = [info, track?.pluginInfo || {}];

    for (const object of objects) {
        for (const key of possibleKeys) {
            const value = Number(object?.[key]);

            if (Number.isFinite(value) && value > 0) {
                return value;
            }
        }
    }

    return null;
}

function popularityScore(track) {
    const value = getPopularity(track);

    if (value === null) return 0;

    return Math.min(5, Math.log10(value + 1) / 2);
}


function scoreCandidate(seed, candidate, recentArtists = new Set()) {
    const seedLanguage = detectLanguage(seed);
    const candidateLanguage = detectLanguage(candidate);

    const seedGenres = detectTags(seed, GENRES);
    const candidateGenres = detectTags(candidate, GENRES);

    const seedMoods = detectTags(seed, MOODS);
    const candidateMoods = detectTags(candidate, MOODS);

    const seedText = getTrackText(seed);
    const candidateText = getTrackText(candidate);

    const textSimilarity = similarity(seedText, candidateText);

    let score = 0;
    let evidence = 0;
    const reasons = [];

    const languageKnown =
        seedLanguage.confidence >= 2 &&
        candidateLanguage.confidence >= 2;

    if (languageKnown) {
        if (seedLanguage.code !== candidateLanguage.code) {
            return {
                score: -100,
                confidence: 'rejected',
                rejected: true,
                reasons: ['bahasa berbeda']
            };
        }

        score += 25;
        evidence++;
        reasons.push('bahasa cocok');
    } else {
        score += 5;
    }

    const genreMatches = seedGenres.filter(tag =>
        candidateGenres.includes(tag)
    );

    if (seedGenres.length && candidateGenres.length) {
        if (genreMatches.length) {
            score += 25;
            evidence++;
            reasons.push(`genre cocok: ${genreMatches.join(', ')}`);
        } else {
            score -= 8;
            reasons.push('genre belum terbukti cocok');
        }
    } else {
        score += 5;
    }

    const moodMatches = seedMoods.filter(tag =>
        candidateMoods.includes(tag)
    );

    if (seedMoods.length && candidateMoods.length) {
        if (moodMatches.length) {
            score += 20;
            evidence++;
            reasons.push(`mood cocok: ${moodMatches.join(', ')}`);
        } else {
            score -= 10;
            reasons.push('suasana berbeda');
        }
    } else {
        score += 4;
    }

    score += textSimilarity * 20;

    if (textSimilarity >= 0.25) {
        evidence++;
        reasons.push('metadata relevan');
    }

    const seedArtist = normalize(seed?.info?.author);
    const candidateArtist = normalize(candidate?.info?.author);

    if (seedArtist && candidateArtist) {
        if (recentArtists.has(candidateArtist) && candidateArtist !== seedArtist) {
            score -= 25;
            reasons.push('artis baru saja diputar');
        } else if (seedArtist !== candidateArtist) {
            score += 5;
            reasons.push('variasi artis');
        } else {
            score -= 5;
            reasons.push('artis sama');
        }
    }

    const popularity = popularityScore(candidate);
    score += popularity;

    if (popularity > 0) {
        reasons.push('popularitas tersedia');
    }

    let confidence = 'low';

    if (evidence >= 3) {
        confidence = 'high';
    } else if (evidence >= 2) {
        confidence = 'medium';
    }

    return {
        score: Math.round(score * 100) / 100,
        confidence,
        evidence,
        rejected: false,
        reasons
    };
}

function minimumScore(candidate) {
    if (candidate.confidence === 'high') return 48;
    if (candidate.confidence === 'medium') return 38;
    return 35;
}

async function loadHistory() {
    if (historyCache) return historyCache;

    try {
        const raw = await readFile(HISTORY_FILE, 'utf8');
        const parsed = JSON.parse(raw);

        historyCache =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed
                : {};
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('[SMART RADIO HISTORY READ]', error);
        }

        historyCache = {};
    }

    return historyCache;
}

async function saveHistory() {
    const history = await loadHistory();

    const operation = writeQueue.then(async () => {
        const temporary = new URL(
            '../../smart-radio-history.tmp',
            import.meta.url
        );

        await writeFile(
            temporary,
            JSON.stringify(history, null, 2),
            'utf8'
        );

        await rename(temporary, HISTORY_FILE);
    });

    writeQueue = operation.catch(error => {
        console.error('[SMART RADIO HISTORY WRITE]', error);
    });

    await operation;
}

export async function recordTrackStart(guildId, track) {
    try {
        if (!guildId || !track?.info) return;

        const history = await loadHistory();
        const key = trackKey(track);

        if (!key) return;

        history[guildId] ||= [];

        const entries = history[guildId];

        if (entries.at(-1)?.key === key) return;

        entries.push({
            key,
            title: track.info.title || 'Unknown',
            author: track.info.author || 'Unknown',
            artistKey: normalize(track.info.author),
            startedAt: new Date().toISOString()
        });

        history[guildId] = entries.slice(-HISTORY_LIMIT);

        await saveHistory();
    } catch (error) {
        console.error('[SMART RADIO HISTORY]', error);
    }
}

function withTimeout(promise, milliseconds) {
    let timer;

    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(
                () => reject(new Error('Recommendation search timeout')),
                milliseconds
            );
        })
    ]).finally(() => clearTimeout(timer));
}

export async function recommendNextTrack(player, seed) {
    const guildId = player?.guildId;
    const videoId = seed?.info?.identifier;

    if (!guildId || !videoId) return null;

    try {
        console.log(
            `[SMART RADIO] Menganalisis: ${seed.info.title || 'Unknown'}`
        );

        const history = await loadHistory();
        const recentEntries = (history[guildId] || [])
            .slice(-RECENT_LIMIT);

        const recent = new Set(
            recentEntries.map(entry => entry.key)
        );

        const recentArtists = new Set(
            recentEntries
                .slice(-8)
                .map(entry => normalize(entry.artistKey || entry.author))
                .filter(Boolean)
        );

        const result = await withTimeout(
            player.search(`ytrec:${videoId}`, null),
            SEARCH_TIMEOUT
        );

        const candidates = result?.tracks || [];
        const ranked = [];
        const seen = new Set();

        for (const candidate of candidates) {
            const info = candidate?.info || {};
            const key = trackKey(candidate);

            if (!info.identifier || !key) continue;
            if (key === trackKey(seed)) continue;
            if (recent.has(key) || seen.has(key)) continue;

            seen.add(key);

            const duration = Number(info.duration || 0);

            if (duration && (duration < 45000 || duration > 1200000)) {
                continue;
            }

            const ranking = scoreCandidate(seed, candidate, recentArtists);

            ranked.push({
                track: candidate,
                ...ranking
            });
        }

        ranked.sort((a, b) => b.score - a.score);

        console.log(
            `[SMART RADIO] ${ranked.length} kandidat lolos pemeriksaan dasar.`
        );

        for (const item of ranked.slice(0, 5)) {
            console.log(
                `[SMART RADIO SCORE] ${item.score} | ${item.track.info.title} | ${item.reasons.join(', ')}`
            );
        }

        const selected = ranked.find(item =>
            !item.rejected &&
            item.score >= minimumScore(item) &&
            item.confidence !== 'low'
        );

        if (!selected) {
            console.log(
                `[SMART RADIO] Tidak ada kandidat yang memenuhi skor minimum ${MIN_SCORE}.`
            );
            return null;
        }

        console.log(
            `[SMART RADIO SELECTED] ${selected.track.info.title} | Score: ${selected.score}`
        );

        return {
            track: selected.track,
            score: selected.score,
            reasons: selected.reasons
        };
    } catch (error) {
        console.error('[SMART RADIO ERROR]', error.message || error);
        return null;
    }
}
