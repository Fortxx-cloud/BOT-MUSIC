import {
    NodeType,
    DefaultSources,
    NodeLinkDefaultSources
} from 'lavalink-client';

function readNode(id, uri, password, type, priority) {
    if (!uri || !password) {
        throw new Error(`Audio node ${id}: URI/password belum lengkap.`);
    }

    const parsed = new URL(uri);
    const nodeType = type.toLowerCase() === 'nodelink'
        ? NodeType.NodeLink
        : NodeType.Lavalink;

    return {
        id,
        host: parsed.hostname,
        port: Number(
            parsed.port || (parsed.protocol === 'https:' ? 443 : 80)
        ),
        authorization: password,
        secure: parsed.protocol === 'https:',
        nodeType,
        retryAmount: 10,
        retryDelay: 5000,
        enablePingOnStatsCheck: true,
        autoChecks: {
            pluginValidations: false,
            sourcesValidations: false
        },
        priority
    };
}

function loadAudioNodes() {
    const nodes = [];

    for (let i = 1; i <= 50; i++) {
        const uri = process.env[`AUDIO_NODE_${i}_URI`];

        if (!uri) continue;

        nodes.push(readNode(
            process.env[`AUDIO_NODE_${i}_ID`] || `AUDIO-${i}`,
            uri,
            process.env[`AUDIO_NODE_${i}_PASSWORD`],
            process.env[`AUDIO_NODE_${i}_TYPE`] || 'Lavalink',
            Number(process.env[`AUDIO_NODE_${i}_PRIORITY`] || i)
        ));
    }

    // Backward compatibility dengan konfigurasi lama.
    if (nodes.length === 0) {
        const legacyType = (process.env.AUDIO_NODE || 'nodelink').toLowerCase();

        const uri = legacyType === 'kairo'
            ? process.env.KAIRO_URI || process.env.LAVALINK_URI
            : 'http://node18.botkeep.cloud:61256';

        const password = legacyType === 'kairo'
            ? process.env.KAIRO_PASSWORD || process.env.LAVALINK_PASSWORD
            : process.env.LAVALINK_PASSWORD;

        nodes.push(readNode(
            legacyType === 'kairo' ? 'ZOMA-KAIRO' : 'ZOMA-NODELINK',
            uri,
            password,
            legacyType === 'kairo' ? 'Lavalink' : 'NodeLink',
            1
        ));
    }

    return nodes.sort((a, b) => a.priority - b.priority);
}

export const AUDIO_NODES = loadAudioNodes();

export const AUDIO_SOURCE_RECORD = {
    ...DefaultSources,
    ...NodeLinkDefaultSources
};
