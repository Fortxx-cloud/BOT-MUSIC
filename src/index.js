import 'dotenv/config';

import {
    ActionRowBuilder,
    ActivityType,
    ButtonBuilder,
    ButtonStyle,
    Client,
    EmbedBuilder,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    StringSelectMenuBuilder
} from 'discord.js';

import {
    LavalinkManager,
    NodeType,
    NodeLinkDefaultSources
} from 'lavalink-client';

const TOKEN = process.env.DISCORD_TOKEN;
const AUDIO_NODE = (process.env.AUDIO_NODE || 'nodelink').toLowerCase();
const NODE_URI = AUDIO_NODE === 'kairo'
    ? (process.env.KAIRO_URI || process.env.LAVALINK_URI)
    : process.env.LAVALINK_URI;
const NODE_PASSWORD = AUDIO_NODE === 'kairo'
    ? (process.env.KAIRO_PASSWORD || process.env.LAVALINK_PASSWORD)
    : process.env.LAVALINK_PASSWORD;

const BRAND = 'ZOMA APP 🎩';
const COLOR = 0x8B0000;
const QUEUE_PAGE_SIZE = 8;
const SEARCH_RESULT_LIMIT = 5;

if (!TOKEN || !NODE_URI || !NODE_PASSWORD) {
    console.error('Environment Discord atau audio node belum lengkap.');
    process.exit(1);
}

let nodeURL;
try {
    nodeURL = new URL(NODE_URI);
} catch {
    console.error('Format LAVALINK_URI/KAIRO_URI tidak valid.');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ]
});

const requesterByTrack = new Map();
const noticeChannels = new Map();
const dashboardCollectors = new Map();

const EQ_15_BAND = [
    { band: 0, gain: 0.02 },
    { band: 1, gain: 0.04 },
    { band: 2, gain: 0.06 },
    { band: 3, gain: 0.05 },
    { band: 4, gain: 0.02 },
    { band: 5, gain: -0.02 },
    { band: 6, gain: -0.03 },
    { band: 7, gain: -0.02 },
    { band: 8, gain: 0.01 },
    { band: 9, gain: 0.03 },
    { band: 10, gain: 0.04 },
    { band: 11, gain: 0.04 },
    { band: 12, gain: 0.02 },
    { band: 13, gain: 0.00 },
    { band: 14, gain: -0.02 }
];

const lavalink = new LavalinkManager({
    nodes: [{
        id: AUDIO_NODE === 'kairo' ? 'ZOMA-KAIRO' : 'ZOMA-NODELINK',
        host: nodeURL.hostname,
        port: Number(nodeURL.port || (nodeURL.protocol === 'https:' ? 443 : 80)),
        authorization: NODE_PASSWORD,
        secure: nodeURL.protocol === 'https:',
        nodeType: NodeType.NodeLink,
        retryAmount: 10,
        retryDelay: 5000
    }],

    sendToShard: (guildId, payload) => {
        const guild = client.guilds.cache.get(guildId);
        guild?.shard?.send(payload);
    },

    client: {
        id: '0',
        username: BRAND
    },

    autoSkip: true,
    autoSkipOnResolveError: true,

    playerOptions: {
        defaultSearchPlatform: 'ytmsearch',
        useUnresolvedData: true,
        onDisconnect: {
            autoReconnect: true,
            autoReconnectOnlyWithTracks: true,
            destroyPlayer: false
        },
        onEmptyQueue: {
            destroyAfterMs: 0,
            autoPlayFunction: async (player, lastPlayedTrack) => {
                // Autoplay parsial: coba cari lagu lain dari artis yang sama.
                const author = lastPlayedTrack?.info?.author;
                if (!author || !lavalink.useable) return;

                try {
                    const result = await player.search(
                        `ytmsearch:${author}`,
                        getRequester(lastPlayedTrack)
                    );

                    const candidates = result?.tracks || [];
                    const next = candidates.find(track =>
                        track?.info?.identifier !== lastPlayedTrack?.info?.identifier
                    );

                    if (next) {
                        rememberRequester(next, getRequester(lastPlayedTrack));
                        player.queue.add(next);
                    }
                } catch (error) {
                    console.error('[AUTOPLAY]', error);
                }
            }
        }
    },

    queueOptions: {
        maxPreviousTracks: 25
    }
});

lavalink.utils.SourcesRecord = NodeLinkDefaultSources;
client.lavalink = lavalink;

function makeEmbed(title, description = '', color = COLOR) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description || '\u200b')
        .setFooter({ text: BRAND });
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'Unknown';
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
        : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function trackKey(track) {
    return track?.info?.identifier || track?.info?.uri || track?.encoded || null;
}

function rememberRequester(track, requester) {
    const key = trackKey(track);
    if (key) requesterByTrack.set(key, requester || null);
    if (track && requester) {
        try {
            track.requester = requester;
        } catch {}
    }
}

function getRequester(track) {
    return track?.requester || requesterByTrack.get(trackKey(track)) || null;
}

function requesterText(track) {
    const requester = getRequester(track);
    return requester?.id ? `<@${requester.id}>` : 'Tidak diketahui';
}

function trackEmbed(track, requester = getRequester(track)) {
    const info = track?.info || {};
    const embed = makeEmbed('🎶 ZOMA SEKARANG MEMUTAR');
    embed.addFields(
        { name: 'Judul', value: info.title || 'Unknown', inline: false },
        { name: 'Artis', value: info.author || 'Unknown', inline: true },
        { name: 'Durasi', value: info.isStream ? 'LIVE' : formatDuration(info.duration), inline: true },
        { name: 'Diminta oleh', value: requester?.id ? `<@${requester.id}>` : 'Tidak diketahui', inline: true }
    );

    if (info.uri) embed.addFields({ name: 'Sumber', value: `[Buka lagu](${info.uri})`, inline: false });
    if (info.artworkUrl) embed.setThumbnail(info.artworkUrl);
    return embed;
}

function getMemberVoiceChannel(interaction) {
    return interaction.guild?.voiceStates?.cache?.get(interaction.user.id)?.channelId
        || interaction.member?.voice?.channelId
        || null;
}

function getPlayer(guildId) {
    return lavalink.getPlayer(guildId);
}

async function checkVoice(interaction, player, requirePlayer = true) {
    const userChannel = getMemberVoiceChannel(interaction);

    if (!userChannel) {
        await interaction.reply({
            content: '❌ Lu harus masuk voice channel dulu.',
            ephemeral: true
        });
        return false;
    }

    if (requirePlayer && !player) {
        await interaction.reply({
            content: '❌ Belum ada musik yang sedang diputar.',
            ephemeral: true
        });
        return false;
    }

    if (player && player.voiceChannelId !== userChannel) {
        await interaction.reply({
            content: '❌ Lu harus berada di voice channel yang sama dengan bot.',
            ephemeral: true
        });
        return false;
    }

    return true;
}

async function connectPlayer(interaction) {
    const voiceChannelId = getMemberVoiceChannel(interaction);
    if (!voiceChannelId) throw new Error('Lu harus masuk voice channel dulu.');

    let player = getPlayer(interaction.guildId);

    if (!player) {
        player = lavalink.createPlayer({
            guildId: interaction.guildId,
            voiceChannelId,
            textChannelId: interaction.channelId,
            volume: 100,
            selfDeaf: true,
            selfMute: false,
            instaUpdateFiltersFix: true,
            applyVolumeAsFilter: false
        });

        await player.connect();
        try {
            await player.filterManager.setEQ(EQ_15_BAND);
        } catch (error) {
            console.error('[EQ]', error);
        }
    } else if (player.voiceChannelId !== voiceChannelId) {
        await player.changeVoiceState({
            voiceChannelId,
            selfDeaf: true,
            selfMute: false
        });
    }

    noticeChannels.set(interaction.guildId, interaction.channelId);
    return player;
}

async function sendNotice(guildId, embed) {
    const channelId = noticeChannels.get(guildId);
    if (!channelId) return;

    try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased()) await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('[MUSIC NOTICE]', error);
    }
}

async function startQueuedTrack(player) {
    if (!player || player.playing || player.paused) return;
    const next = player.queue.tracks.shift();
    if (!next) return;

    player.queue.current = next;
    await player.play({ clientTrack: next });
}

async function addTracks(player, tracks, requester) {
    for (const track of tracks) rememberRequester(track, requester);
    await player.queue.add(tracks);
    if (!player.playing && !player.paused) await startQueuedTrack(player);
}

function playerButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('zoma:pause').setLabel('Pause').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('zoma:resume').setLabel('Resume').setEmoji('▶️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('zoma:skip').setLabel('Skip').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('zoma:stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
    );
}

function searchEmbed(tracks, query) {
    const embed = makeEmbed('🔎 HASIL PENCARIAN ZOMA');
    embed.setDescription(`Kata kunci: **${query}**\n\n${tracks.map((track, index) => {
        const info = track.info || {};
        return `**${index + 1}. ${info.title || 'Unknown'}**\n` +
            `Artis: ${info.author || 'Unknown'} • ${formatDuration(info.duration)}`;
    }).join('\n\n')}`);

    if (tracks[0]?.info?.artworkUrl) embed.setThumbnail(tracks[0].info.artworkUrl);
    return embed;
}

async function showSearchSelection(interaction, player, tracks, query) {
    const options = tracks.slice(0, SEARCH_RESULT_LIMIT).map((track, index) => ({
        label: String(track.info?.title || `Track ${index + 1}`).slice(0, 100),
        description: `${track.info?.author || 'Unknown'} • ${formatDuration(track.info?.duration)}`.slice(0, 100),
        value: String(index)
    }));

    const select = new StringSelectMenuBuilder()
        .setCustomId('zoma_search_select')
        .setPlaceholder('Pilih lagu yang ingin diputar')
        .addOptions(options);

    const message = await interaction.editReply({
        embeds: [searchEmbed(tracks, query)],
        components: [new ActionRowBuilder().addComponents(select)]
    });

    const collector = message.createMessageComponentCollector({
        time: 120_000,
        filter: component => component.user.id === interaction.user.id
    });

    collector.on('collect', async component => {
        try {
            const selected = tracks[Number(component.values[0])];
            if (!selected) {
                await component.reply({ content: 'Pilihan lagu tidak ditemukan.', ephemeral: true });
                return;
            }

            rememberRequester(selected, interaction.user);
            await addTracks(player, [selected], interaction.user);

            await component.update({
                embeds: [makeEmbed('✅ LAGU DITAMBAHKAN', `**${selected.info?.title || 'Unknown'}** berhasil ditambahkan ke antrean.`)],
                components: []
            });
        } catch (error) {
            console.error('[SEARCH SELECT]', error);
            if (!component.replied && !component.deferred) {
                await component.reply({ content: '❌ Gagal menambahkan lagu.', ephemeral: true }).catch(() => {});
            }
        }
    });

    collector.on('end', async () => {
        await message.edit({ components: [] }).catch(() => {});
    });
}

function queueEmbed(player, page = 0) {
    const tracks = player.queue.tracks || [];
    const totalPages = Math.max(1, Math.ceil(tracks.length / QUEUE_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * QUEUE_PAGE_SIZE;
    const pageTracks = tracks.slice(start, start + QUEUE_PAGE_SIZE);
    const current = player.queue.current;
    const totalDuration = tracks.reduce((sum, track) => {
        const duration = track.info?.duration;
        return sum + (Number.isFinite(duration) ? duration : 0);
    }, 0);

    const embed = makeEmbed('📜 ZOMA MUSIC QUEUE');
    let description = current
        ? `**Sedang diputar:** ${current.info?.title || 'Unknown'}\n`
        : '**Sedang diputar:** Tidak ada\n';

    description += `**Antrean:** ${tracks.length} lagu\n`;
    description += `**Total durasi antrean:** ${formatDuration(totalDuration)}\n`;
    description += `**Loop:** ${player.repeatMode || 'off'}\n\n`;

    if (pageTracks.length) {
        description += pageTracks.map((track, index) => {
            const info = track.info || {};
            return `**${start + index + 1}. ${info.title || 'Unknown'}**\n` +
                `${info.author || 'Unknown'} • ${formatDuration(info.duration)} • ${requesterText(track)}`;
        }).join('\n\n');
    } else {
        description += 'Antrean masih kosong.';
    }

    embed.setDescription(description);
    if (current?.info?.artworkUrl) embed.setThumbnail(current.info.artworkUrl);
    embed.setFooter({ text: `${BRAND} • Halaman ${safePage + 1}/${totalPages}` });
    return { embed, page: safePage, totalPages, pageTracks, start };
}

function queueComponents(player, page, clearing = false) {
    const data = queueEmbed(player, page);
    const rows = [];

    if (data.pageTracks.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId('zoma_queue_remove')
            .setPlaceholder('Pilih lagu untuk dihapus')
            .addOptions(data.pageTracks.map((track, index) => ({
                label: String(track.info?.title || `Track ${index + 1}`).slice(0, 100),
                description: `Posisi antrean ${data.start + index + 1}`.slice(0, 100),
                value: String(data.start + index)
            })));
        rows.push(new ActionRowBuilder().addComponents(select));
    }

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('zoma_q_prev').setLabel('Prev').setStyle(ButtonStyle.Secondary).setDisabled(data.page <= 0),
        new ButtonBuilder().setCustomId('zoma_q_next').setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(data.page >= data.totalPages - 1),
        new ButtonBuilder().setCustomId('zoma_q_refresh').setLabel('Refresh').setStyle(ButtonStyle.Primary)
    ));

    if (clearing) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('zoma_q_clear_yes').setLabel('Ya, hapus antrean').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('zoma_q_clear_no').setLabel('Batal').setStyle(ButtonStyle.Secondary)
        ));
    } else {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('zoma_q_shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('zoma_q_loop').setLabel('Loop').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('zoma_q_clear').setLabel('Clear Queue').setStyle(ButtonStyle.Danger)
        ));
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('zoma:pause').setLabel('Pause').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('zoma:resume').setLabel('Resume').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('zoma:skip').setLabel('Skip').setStyle(ButtonStyle.Primary)
        ));
    }

    return rows;
}

async function openQueueDashboard(interaction, player) {
    let page = 0;
    const first = queueEmbed(player, page);
    await interaction.reply({
        embeds: [first.embed],
        components: queueComponents(player, page)
    });

    const message = await interaction.fetchReply();
    const collector = message.createMessageComponentCollector({ time: 300_000 });
    dashboardCollectors.set(message.id, collector);

    collector.on('collect', async component => {
        if (component.user.id !== interaction.user.id) {
            await component.reply({ content: 'Dashboard ini hanya bisa digunakan oleh yang membukanya.', ephemeral: true });
            return;
        }

        const currentPlayer = getPlayer(interaction.guildId);
        if (!currentPlayer) {
            await component.update({ embeds: [makeEmbed('❌ PLAYER TIDAK ADA')], components: [] });
            collector.stop();
            return;
        }

        if (getMemberVoiceChannel(component) !== currentPlayer.voiceChannelId) {
            await component.reply({ content: 'Lu harus berada di voice channel yang sama dengan bot.', ephemeral: true });
            return;
        }

        try {
            const id = component.customId;

            if (id === 'zoma_queue_remove') {
                const index = Number(component.values[0]);
                const removed = currentPlayer.queue.tracks[index];
                if (removed) await currentPlayer.queue.splice(index, 1);
                const refreshed = queueEmbed(currentPlayer, page);
                await component.update({
                    embeds: [makeEmbed('🗑️ LAGU DIHAPUS', `${removed?.info?.title || 'Lagu'} dihapus dari antrean.`), refreshed.embed],
                    components: queueComponents(currentPlayer, page)
                });
                return;
            }

            if (id === 'zoma_q_prev') page--;
            else if (id === 'zoma_q_next') page++;
            else if (id === 'zoma_q_shuffle') await currentPlayer.queue.shuffle();
            else if (id === 'zoma_q_loop') {
                const modes = ['off', 'track', 'queue'];
                const currentIndex = modes.indexOf(currentPlayer.repeatMode || 'off');
                await currentPlayer.setRepeatMode(modes[(currentIndex + 1) % modes.length]);
            } else if (id === 'zoma_q_clear') {
                await component.update({
                    embeds: [makeEmbed('⚠️ KONFIRMASI', 'Yakin ingin menghapus seluruh antrean lagu?')],
                    components: queueComponents(currentPlayer, page, true)
                });
                return;
            } else if (id === 'zoma_q_clear_yes') {
                await currentPlayer.queue.splice(0, currentPlayer.queue.tracks.length);
                const refreshed = queueEmbed(currentPlayer, 0);
                page = 0;
                await component.update({ embeds: [refreshed.embed], components: queueComponents(currentPlayer, page) });
                return;
            } else if (id === 'zoma_q_clear_no') {
                // Kembali ke dashboard normal.
            }

            const refreshed = queueEmbed(currentPlayer, page);
            page = refreshed.page;
            await component.update({
                embeds: [refreshed.embed],
                components: queueComponents(currentPlayer, page)
            });
        } catch (error) {
            console.error('[QUEUE DASHBOARD]', error);
            if (!component.replied && !component.deferred) {
                await component.reply({ content: '❌ Gagal memproses dashboard.', ephemeral: true }).catch(() => {});
            }
        }
    });

    collector.on('end', async () => {
        dashboardCollectors.delete(message.id);
        await message.edit({ components: [] }).catch(() => {});
    });
}

const commands = [
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Cek status ZOMA APP'),
    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Putar lagu atau playlist')
        .addStringOption(option => option.setName('query').setDescription('Judul lagu atau URL').setRequired(true)),
    new SlashCommandBuilder()
        .setName('search')
        .setDescription('Cari lagu dan pilih salah satu dari 5 hasil')
        .addStringOption(option => option.setName('query').setDescription('Judul lagu').setRequired(true)),
    new SlashCommandBuilder().setName('pause').setDescription('Jeda musik'),
    new SlashCommandBuilder().setName('resume').setDescription('Lanjutkan musik'),
    new SlashCommandBuilder().setName('skip').setDescription('Lewati lagu'),
    new SlashCommandBuilder().setName('stop').setDescription('Hentikan musik dan kosongkan antrean'),
    new SlashCommandBuilder().setName('queue').setDescription('Buka dashboard antrean musik'),
    new SlashCommandBuilder()
        .setName('volume')
        .setDescription('Atur volume musik')
        .addIntegerOption(option => option.setName('angka').setDescription('Volume 1 sampai 100').setMinValue(1).setMaxValue(100).setRequired(true)),
    new SlashCommandBuilder()
        .setName('loop')
        .setDescription('Atur mode pengulangan')
        .addStringOption(option => option.setName('mode').setDescription('Mode loop').setRequired(true)
            .addChoices(
                { name: 'Off', value: 'off' },
                { name: 'Track', value: 'track' },
                { name: 'Queue', value: 'queue' }
            )),
    new SlashCommandBuilder().setName('leave').setDescription('Keluarkan bot dari voice channel')
].map(command => command.toJSON());

client.on('raw', data => {
    lavalink.sendRawData(data).catch(error => console.error('[VOICE RAW]', error));
});

client.once('clientReady', async () => {
    console.log('================================');
    console.log('       ZOMA APP ONLINE 🎩');
    console.log('================================');
    console.log(`Bot: ${client.user.tag}`);

    lavalink.options.client.id = client.user.id;
    await lavalink.init({
        id: client.user.id,
        username: client.user.username
    });

    client.user.setPresence({
        activities: [{ name: 'ZOMA APP 🎩 | /search', type: ActivityType.Listening }],
        status: 'online'
    });

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Slash commands berhasil disinkronkan.');
});

lavalink.nodeManager.on('connect', node => {
    console.log(`Audio node CONNECTED: ${node.id}`);
});

lavalink.nodeManager.on('error', (node, error) => {
    console.error(`Audio node ERROR: ${node?.id || 'unknown'}`, error);
});

lavalink.on('trackStart', async (player, track) => {
    const requester = getRequester(track);
    console.log(`[TRACK START] ${track?.info?.title || 'Unknown'} | Guild: ${player.guildId}`);
    await sendNotice(player.guildId, trackEmbed(track, requester));
});

lavalink.on('trackEnd', async (player, track, payload) => {
    console.log(`[TRACK END] ${track?.info?.title || 'Unknown'} | Reason: ${payload?.reason}`);
    if (payload?.reason === 'finished') {
        await sendNotice(player.guildId, makeEmbed('🏁 LAGU SELESAI', `**${track?.info?.title || 'Lagu'}** telah selesai diputar.`));
    } else if (payload?.reason === 'stopped' || payload?.reason === 'replaced') {
        if (payload.reason === 'stopped') {
            await sendNotice(player.guildId, makeEmbed('⏹️ MUSIK DIHENTIKAN', 'Pemutaran musik dihentikan.'));
        }
    }
});

lavalink.on('trackStuck', async (player, track, payload) => {
    console.error(`[TRACK STUCK] ${track?.info?.title || 'Unknown'} | ${payload?.thresholdMs}ms`);
    await sendNotice(player.guildId, makeEmbed('⚠️ LAGU MACET', `**${track?.info?.title || 'Lagu'}** mengalami gangguan saat diputar.`));
});

lavalink.on('trackError', async (player, track, payload) => {
    console.error(`[TRACK ERROR] ${track?.info?.title || 'Unknown'}`, payload?.error || payload?.exception);
    await sendNotice(player.guildId, makeEmbed('❌ MUSIK ERROR', `Gagal memutar **${track?.info?.title || 'lagu'}**.\n${payload?.error || 'Terjadi kesalahan audio.'}`));
});

lavalink.on('queueEnd', async player => {
    console.log(`[QUEUE END] Guild: ${player.guildId}`);
    await sendNotice(player.guildId, makeEmbed('⏹️ MUSIK SELESAI', 'Antrean lagu sudah habis.'));
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isButton() && interaction.customId.startsWith('zoma:')) {
            const player = getPlayer(interaction.guildId);
            if (!await checkVoice(interaction, player)) return;

            if (interaction.customId === 'zoma:pause') {
                await player.pause();
                await interaction.reply({ content: '⏸️ Musik dijeda.', ephemeral: true });
            } else if (interaction.customId === 'zoma:resume') {
                await player.resume();
                await interaction.reply({ content: '▶️ Musik dilanjutkan.', ephemeral: true });
            } else if (interaction.customId === 'zoma:skip') {
                await player.skip();
                await interaction.reply({ content: '⏭️ Lagu dilewati.', ephemeral: true });
            } else if (interaction.customId === 'zoma:stop') {
                await player.stopPlaying(true, false);
                await player.setRepeatMode('off');
                await interaction.reply({ content: '⏹️ Musik dihentikan dan antrean dikosongkan.', ephemeral: true });
            }
            return;
        }

        if (!interaction.isChatInputCommand()) return;

        const command = interaction.commandName;
        const guildId = interaction.guildId;

        if (command === 'ping') {
            await interaction.reply({
                content: `🏓 Pong! ZOMA APP aktif. Latency: ${client.ws.ping}ms`,
                ephemeral: true
            });
            return;
        }

        if (command === 'play' || command === 'search') {
            await interaction.deferReply();
            const query = interaction.options.getString('query', true);
            const player = await connectPlayer(interaction);

            if (!lavalink.useable) {
                await interaction.editReply('❌ Audio node belum siap. Coba lagi sebentar.');
                return;
            }

            const result = await player.search(query, interaction.user);
            const tracks = result?.tracks || [];

            if (!tracks.length) {
                await interaction.editReply('❌ Lagu tidak ditemukan.');
                return;
            }

            if (command === 'search') {
                await showSearchSelection(interaction, player, tracks.slice(0, SEARCH_RESULT_LIMIT), query);
                return;
            }

            if (result.playlist && tracks.length > 1) {
                await addTracks(player, tracks, interaction.user);
                const playlistName = result.playlist.name || result.playlist.title || 'Playlist';
                await interaction.editReply({
                    embeds: [makeEmbed('📀 PLAYLIST DITAMBAHKAN', `**${playlistName}**\nBerhasil menambahkan **${tracks.length} lagu** ke antrean.`)],
                    components: []
                });
                return;
            }

            const selected = tracks[0];
            await addTracks(player, [selected], interaction.user);
            await interaction.editReply({
                embeds: [trackEmbed(selected, interaction.user)],
                components: [playerButtons()]
            });
            return;
        }

        const player = getPlayer(guildId);

        if (command === 'pause' || command === 'resume' || command === 'skip' ||
            command === 'stop' || command === 'queue' || command === 'volume' ||
            command === 'loop' || command === 'leave') {
            if (!await checkVoice(interaction, player)) return;
        }

        if (command === 'pause') {
            await player.pause();
            await interaction.reply('⏸️ Musik dijeda.');
        } else if (command === 'resume') {
            await player.resume();
            await interaction.reply('▶️ Musik dilanjutkan.');
        } else if (command === 'skip') {
            await player.skip();
            await interaction.reply('⏭️ Lagu dilewati.');
        } else if (command === 'stop') {
            await player.stopPlaying(true, false);
            await player.setRepeatMode('off');
            await interaction.reply('⏹️ Musik dihentikan dan antrean dikosongkan.');
        } else if (command === 'queue') {
            await openQueueDashboard(interaction, player);
        } else if (command === 'volume') {
            const volume = interaction.options.getInteger('angka', true);
            await player.setVolume(volume);
            await interaction.reply(`🔊 Volume diatur ke **${volume}%**.`);
        } else if (command === 'loop') {
            const mode = interaction.options.getString('mode', true);
            await player.setRepeatMode(mode);
            await interaction.reply(`🔁 Mode loop: **${mode}**.`);
        } else if (command === 'leave') {
            await player.stopPlaying(true, false);
            await player.setRepeatMode('off');
            await player.destroy('Perintah leave');
            await interaction.reply('👋 ZOMA APP keluar dari voice channel.');
        }
    } catch (error) {
        console.error('[INTERACTION ERROR]', error);

        const message = '❌ Terjadi kesalahan saat menjalankan perintah.';
        if (interaction.isRepliable()) {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(message).catch(() => {});
            } else {
                await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
            }
        }
    }
});

client.login(TOKEN).catch(error => {
    console.error('Discord login gagal:', error);
    process.exit(1);
});
