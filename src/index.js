import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';

import {
    ActionRowBuilder,
    ActivityType,
    ButtonBuilder,
    ButtonStyle,
    Client,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
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

import {
    recordTrackStart,
    recommendNextTrack
} from './music/smart-radio.js';

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
const pendingPlaylistTracks = new Map();
const PLAYLIST_FILE = new URL('../playlists.json', import.meta.url);
let playlistWriteQueue = Promise.resolve();

async function readPlaylists() {
    try {
        const data = JSON.parse(await readFile(PLAYLIST_FILE, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

function updatePlaylists(mutator) {
    const operation = playlistWriteQueue.then(async () => {
        const playlists = await readPlaylists();
        const result = await mutator(playlists);
        await writeFile(PLAYLIST_FILE, JSON.stringify(playlists, null, 2));
        return result;
    });
    playlistWriteQueue = operation.catch(() => {});
    return operation;
}

async function savePlaylistTrack(userId, playlistName, track) {
    const name = playlistName.trim();
    if (!name || !track?.encoded || !track?.info) {
        throw new Error('Data playlist atau track tidak valid.');
    }

    return updatePlaylists(playlists => {
        playlists[userId] ||= {};
        playlists[userId][name] ||= [];
        playlists[userId][name].push({
            encoded: track.encoded,
            info: track.info,
            pluginInfo: track.pluginInfo || {},
            savedAt: new Date().toISOString()
        });
        return playlists[userId][name].length;
    });
}

async function deletePlaylist(userId, playlistName) {
    return updatePlaylists(playlists => {
        if (!playlists[userId]?.[playlistName]) return false;
        delete playlists[userId][playlistName];
        if (!Object.keys(playlists[userId]).length) delete playlists[userId];
        return true;
    });
}

async function deletePlaylistTrack(userId, playlistName, index) {
    return updatePlaylists(playlists => {
        const tracks = playlists[userId]?.[playlistName];
        if (!Array.isArray(tracks) || !Number.isInteger(index) || index < 0 || index >= tracks.length) return false;
        tracks.splice(index, 1);
        return true;
    });
}

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
                try {
                    // Jangan mencari rekomendasi jika antrean sudah diisi.
                    if (player.queue.tracks.length > 0) {
                        console.log('[SMART RADIO] Antrean manual terdeteksi. Autoplay dilewati.');
                        return;
                    }

                    const recommendation = await recommendNextTrack(
                        player,
                        lastPlayedTrack
                    );

                    if (!recommendation?.track) return;

                    // Periksa kembali setelah pencarian selesai.
                    // Pengguna mungkin sudah menambahkan lagu saat pencarian berlangsung.
                    if (player.queue.tracks.length > 0) {
                        console.log('[SMART RADIO] Antrean berubah saat pencarian. Rekomendasi dibatalkan.');
                        return;
                    }

                    const next = recommendation.track;

                    rememberRequester(
                        next,
                        getRequester(lastPlayedTrack)
                    );

                    player.queue.add(next);

                    console.log(
                        `[SMART RADIO QUEUED] ${next.info?.title || 'Unknown'} | Score: ${recommendation.score}`
                    );
                } catch (error) {
                    console.error('[SMART RADIO AUTOPLAY]', error);
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
        new ButtonBuilder().setCustomId('zoma:stop').setLabel('Stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('zoma:save_playlist').setLabel('Simpan Playlist').setEmoji('💾').setStyle(ButtonStyle.Secondary)
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
    const tracks = player?.queue?.tracks || [];
    const totalPages = Math.max(1, Math.ceil(tracks.length / QUEUE_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * QUEUE_PAGE_SIZE;
    const pageTracks = tracks.slice(start, start + QUEUE_PAGE_SIZE);
    const current = player?.queue?.current;

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
    description += `**Loop:** ${player?.repeatMode || 'off'}\n\n`;

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
    } else if (player) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('zoma_q_shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('zoma_q_loop').setLabel('Loop').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('zoma_q_clear').setLabel('Clear Queue').setStyle(ButtonStyle.Danger)
        ));

        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('zoma_q_pause').setLabel('Pause').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('zoma_q_resume').setLabel('Resume').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('zoma_q_skip').setLabel('Skip').setStyle(ButtonStyle.Primary)
        ));
    }

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('zoma_pl_open').setLabel('Playlist Saya').setEmoji('💾').setStyle(ButtonStyle.Success)
    ));

    return rows;
}

async function playlistDashboard(userId, selectedName = null, selectedIndex = null) {
    const playlists = await readPlaylists();
    const ownPlaylists = playlists[userId] || {};
    const names = Object.keys(ownPlaylists);
    const embed = makeEmbed('💾 PLAYLIST SAYA');

    if (!names.length) {
        embed.setDescription('Kamu belum memiliki playlist.\nGunakan tombol **Simpan Playlist** pada pesan lagu untuk menyimpan lagu pertama.');
        return {
            embed,
            components: [
                new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('zoma_pl_back').setLabel('Kembali ke Queue').setStyle(ButtonStyle.Secondary)
                )
            ]
        };
    }

    const visibleNames = names.slice(0, 25);
    const rows = [];

    rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('zoma_pl_select')
            .setPlaceholder('Pilih playlist milikmu')
            .addOptions(visibleNames.map(name => ({
                label: name.slice(0, 100),
                description: `${ownPlaylists[name].length} lagu`.slice(0, 100),
                value: name
            })))
    ));

    if (selectedName && Array.isArray(ownPlaylists[selectedName])) {
        const tracks = ownPlaylists[selectedName];
        const safeIndex = Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < tracks.length
            ? selectedIndex : null;

        embed.setDescription(
            `**Playlist:** ${selectedName}\n` +
            `**Jumlah lagu:** ${tracks.length}\n\n` +
            (tracks.length
                ? tracks.slice(0, 10).map((track, index) =>
                    `**${index + 1}. ${track.info?.title || 'Unknown'}**\n${track.info?.author || 'Unknown'}`
                ).join('\n\n')
                : 'Playlist ini kosong.')
        );

        if (tracks.length) {
            rows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('zoma_pl_track')
                    .setPlaceholder('Pilih lagu untuk dihapus')
                    .addOptions(tracks.slice(0, 25).map((track, index) => ({
                        label: String(track.info?.title || `Track ${index + 1}`).slice(0, 100),
                        description: `Lagu nomor ${index + 1}`.slice(0, 100),
                        value: String(index),
                        default: index === safeIndex
                    })))
            ));
        }

        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('zoma_pl_play').setLabel('Putar Playlist').setEmoji('▶️').setStyle(ButtonStyle.Success).setDisabled(!tracks.length),
            new ButtonBuilder().setCustomId('zoma_pl_remove').setLabel('Hapus Lagu').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(safeIndex === null),
            new ButtonBuilder().setCustomId('zoma_pl_delete').setLabel('Hapus Playlist').setStyle(ButtonStyle.Danger)
        ));
    } else {
        embed.setDescription(
            `Kamu memiliki **${names.length} playlist**.\nPilih playlist dari menu di atas untuk melihat lagu-lagunya.` +
            (names.length > 25 ? '\n\nHanya 25 playlist pertama yang ditampilkan.' : '')
        );
    }

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('zoma_pl_back').setLabel('Kembali ke Queue').setStyle(ButtonStyle.Secondary)
    ));

    return { embed, components: rows };
}

async function openQueueDashboard(interaction, player) {
    let page = 0;
    let selectedPlaylist = null;
    let selectedTrack = null;
    let showingPlaylists = false;

    const first = queueEmbed(player, page);
    await interaction.deferReply();

    const message = await interaction.editReply({
        embeds: [first.embed],
        components: queueComponents(player, page)
    });
    const collector = message.createMessageComponentCollector({ time: 900_000 });
    dashboardCollectors.set(message.id, collector);

    collector.on('collect', async component => {
        if (component.user.id !== interaction.user.id) {
            await component.reply({
                content: 'Dashboard ini hanya bisa digunakan oleh yang membukanya.',
                ephemeral: true
            });
            return;
        }

        try {
            const id = component.customId;

            if (id === 'zoma_pl_open') {
                showingPlaylists = true;
                selectedPlaylist = null;
                selectedTrack = null;
                const view = await playlistDashboard(component.user.id);
                await component.update({ embeds: [view.embed], components: view.components });
                return;
            }

            if (id === 'zoma_pl_select') {
                showingPlaylists = true;
                selectedPlaylist = component.values[0];
                selectedTrack = null;
                const view = await playlistDashboard(component.user.id, selectedPlaylist);
                await component.update({ embeds: [view.embed], components: view.components });
                return;
            }

            if (id === 'zoma_pl_track') {
                selectedTrack = Number(component.values[0]);
                const view = await playlistDashboard(component.user.id, selectedPlaylist, selectedTrack);
                await component.update({ embeds: [view.embed], components: view.components });
                return;
            }

            if (id === 'zoma_pl_remove') {
                if (!selectedPlaylist || !Number.isInteger(selectedTrack)) {
                    await component.reply({ content: 'Pilih lagu yang ingin dihapus terlebih dahulu.', ephemeral: true });
                    return;
                }

                const removed = await deletePlaylistTrack(component.user.id, selectedPlaylist, selectedTrack);
                selectedTrack = null;
                const playlists = await readPlaylists();

                if (!playlists[component.user.id]?.[selectedPlaylist]) selectedPlaylist = null;

                const view = await playlistDashboard(component.user.id, selectedPlaylist);
                await component.update({ embeds: [view.embed], components: view.components });
                return;
            }

            if (id === 'zoma_pl_delete') {
                if (!selectedPlaylist) {
                    await component.reply({ content: 'Pilih playlist terlebih dahulu.', ephemeral: true });
                    return;
                }

                await deletePlaylist(component.user.id, selectedPlaylist);
                selectedPlaylist = null;
                selectedTrack = null;
                const view = await playlistDashboard(component.user.id);
                await component.update({ embeds: [makeEmbed('🗑️ PLAYLIST DIHAPUS', 'Playlist berhasil dihapus.'), view.embed], components: view.components });
                return;
            }

            if (id === 'zoma_pl_play') {
                if (!selectedPlaylist) {
                    await component.reply({ content: 'Pilih playlist terlebih dahulu.', ephemeral: true });
                    return;
                }

                const voiceChannel = getMemberVoiceChannel(component);
                if (!voiceChannel) {
                    await component.reply({ content: 'Masuk voice channel terlebih dahulu untuk memutar playlist.', ephemeral: true });
                    return;
                }

                await connectPlayer(component);
                const playbackPlayer = getPlayer(component.guildId);

                if (!playbackPlayer || !lavalink.useable) {
                    await component.reply({ content: '❌ Audio node belum siap.', ephemeral: true });
                    return;
                }

                const playlists = await readPlaylists();
                const savedTracks = playlists[component.user.id]?.[selectedPlaylist] || [];

                if (!savedTracks.length) {
                    await component.reply({ content: 'Playlist ini kosong.', ephemeral: true });
                    return;
                }

                const restoredTracks = savedTracks.map(saved => lavalink.utils.buildTrack({
                    encoded: saved.encoded,
                    info: saved.info,
                    pluginInfo: saved.pluginInfo || {}
                }, component.user));

                await addTracks(playbackPlayer, restoredTracks, component.user);

                showingPlaylists = false;
                const refreshed = queueEmbed(playbackPlayer, 0);
                page = 0;
                await component.update({
                    embeds: [makeEmbed('▶️ PLAYLIST DIMASUKKAN', `**${selectedPlaylist}** • ${restoredTracks.length} lagu`), refreshed.embed],
                    components: queueComponents(playbackPlayer, page)
                });
                return;
            }

            if (id === 'zoma_pl_back') {
                showingPlaylists = false;
                const currentPlayer = getPlayer(interaction.guildId);
                const refreshed = queueEmbed(currentPlayer, page);
                page = refreshed.page;
                await component.update({
                    embeds: [refreshed.embed],
                    components: queueComponents(currentPlayer, page)
                });
                return;
            }

            const currentPlayer = getPlayer(interaction.guildId);

            if (!currentPlayer) {
                await component.reply({
                    content: 'Belum ada player aktif. Gunakan Playlist Saya untuk melihat koleksi lagumu.',
                    ephemeral: true
                });
                return;
            }

            if (getMemberVoiceChannel(component) !== currentPlayer.voiceChannelId) {
                await component.reply({
                    content: 'Lu harus berada di voice channel yang sama dengan bot.',
                    ephemeral: true
                });
                return;
            }

            if (id === 'zoma_queue_remove') {
                const index = Number(component.values[0]);
                const removed = currentPlayer.queue.tracks[index];
                if (removed) await currentPlayer.queue.splice(index, 1);

                const refreshed = queueEmbed(currentPlayer, page);
                page = refreshed.page;
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
                page = 0;
            } else if (id === 'zoma_q_clear_no') {
                // Kembali ke dashboard normal.
            } else if (id === 'zoma_q_pause') {
                await currentPlayer.pause();
            } else if (id === 'zoma_q_resume') {
                await currentPlayer.resume();
            } else if (id === 'zoma_q_skip') {
                await currentPlayer.skip();
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
                await component.reply({
                    content: `❌ Gagal memproses dashboard: ${error.message}`,
                    ephemeral: true
                }).catch(() => {});
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
        .setName('help')
        .setDescription('Kenalan dengan fitur dan perintah ZOMA APP'),

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
    const registered = await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('Slash commands terkirim:', registered.map(c => c.name).join(', '));

    const verified = await rest.get(Routes.applicationCommands(client.user.id));
    console.log('Slash commands tersimpan di Discord:', verified.length);
    console.log('Daftar command Discord:', verified.map(c => '/' + c.name).join(', '));
});

lavalink.nodeManager.on('connect', node => {
    console.log(`Audio node CONNECTED: ${node.id}`);
});

lavalink.nodeManager.on('error', (node, error) => {
    console.error(`Audio node ERROR: ${node?.id || 'unknown'}`, error);
});

lavalink.on('trackStart', async (player, track) => {
    const requester = getRequester(track);

    await recordTrackStart(player.guildId, track);

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
        if (interaction.isButton() && interaction.customId === 'zoma:save_playlist') {
            const saved = pendingPlaylistTracks.get(interaction.message.id);

            if (!saved) {
                await interaction.reply({ content: '❌ Data lagu sudah kedaluwarsa.', ephemeral: true });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId(`zoma_save_playlist:${interaction.message.id}`)
                .setTitle('Simpan Lagu ke Playlist');

            const input = new TextInputBuilder()
                .setCustomId('playlist_name')
                .setLabel('Nama playlist')
                .setPlaceholder('Contoh: Lagu Favorit')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(50);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            return;
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith('zoma_save_playlist:')) {
            const messageId = interaction.customId.split(':')[1];
            const saved = pendingPlaylistTracks.get(messageId);

            if (!saved) {
                await interaction.reply({ content: '❌ Data lagu sudah kedaluwarsa.', ephemeral: true });
                return;
            }

            const name = interaction.fields.getTextInputValue('playlist_name').trim();
            if (!name) {
                await interaction.reply({ content: '❌ Nama playlist tidak boleh kosong.', ephemeral: true });
                return;
            }

            try {
                const count = await savePlaylistTrack(interaction.user.id, name, saved);
                await interaction.reply({
                    content: `💾 **${saved.info?.title || 'Lagu'}** disimpan ke playlist **${name}**. Total lagu: **${count}**.`,
                    ephemeral: true
                });
            } catch (error) {
                console.error('[PLAYLIST SAVE]', error);
                await interaction.reply({ content: '❌ Gagal menyimpan playlist.', ephemeral: true });
            }
            return;
        }

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

        if (command === 'help') {
            const helpEmbed = new EmbedBuilder()
                .setColor(0x2B2D31)
                .setAuthor({
                    name: 'ZOMA APP 🎩',
                    iconURL: client.user.displayAvatarURL()
                })
                .setTitle('𓆩 HE!P — ZOMA APP 𓆪')
                .setDescription(
                    'Hey! Bingung mau mulai dari mana? Santai, ZOMA siap nemenin musik kamu. 🎶\\n' +
                    'Pilih lagu, atur antrean, atau biarkan Smart Radio mencari teman untuk lagu berikutnya.'
                )
                .addFields(
                    {
                        name: '🎵 Putar Musik',
                        value:
                            '`/play` — Putar lagu dari judul atau link YouTube.\\n' +
                            '`/search` — Cari lagu dan pilih dari 5 hasil yang tersedia.',
                        inline: false
                    },
                    {
                        name: '🎛️ Kontrol Musik',
                        value:
                            '`/pause` — Istirahatkan musik sebentar.\\n' +
                            '`/resume` — Lanjutkan lagu.\\n' +
                            '`/skip` — Lewati lagu sekarang.\\n' +
                            '`/stop` — Hentikan musik dan kosongkan antrean.\\n' +
                            '`/leave` — Minta ZOMA keluar dari voice channel.',
                        inline: false
                    },
                    {
                        name: '📜 Antrean & Playlist',
                        value:
                            '`/queue` — Buka dashboard antrean, atur lagu, shuffle, loop, dan playlist pribadi.\\n' +
                            '💾 Gunakan tombol **Save Playlist** pada pesan lagu untuk menyimpan lagu favorit.',
                        inline: false
                    },
                    {
                        name: '🔊 Pengaturan',
                        value:
                            '`/volume` — Atur volume musik dari 1–100%.\\n' +
                            '`/loop` — Pilih pengulangan Off, Track, atau Queue.',
                        inline: false
                    },
                    {
                        name: '📻 Smart Radio',
                        value:
                            'Kalau antrean kosong, ZOMA bisa mencarikan lagu berikutnya. Rekomendasi mempertimbangkan bahasa, genre, suasana lagu, dan riwayat pemutaran supaya musik tidak terasa itu-itu saja.',
                        inline: false
                    },
                    {
                        name: '🏓 Lainnya',
                        value: '`/ping` — Cek apakah ZOMA sedang aktif.',
                        inline: false
                    }
                )
                .setFooter({ text: 'Made to keep the music going. 🎩' })
                .setTimestamp();

            await interaction.reply({ embeds: [helpEmbed] });
            return;
        }

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

            const isYoutubeUrl = /^https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|music\.youtube\.com)\//i.test(query.trim());
            const searchQuery = isYoutubeUrl ? query.trim() : query;

            console.log(`[PLAY] ${isYoutubeUrl ? 'YouTube URL' : 'Search'}: ${searchQuery}`);

            const result = await player.search(searchQuery, interaction.user);
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

            const playMessage = await interaction.fetchReply();
            pendingPlaylistTracks.set(playMessage.id, selected);

            const cleanup = setTimeout(() => {
                pendingPlaylistTracks.delete(playMessage.id);
            }, 30 * 60 * 1000);
            cleanup.unref?.();

            return;
        }

        const player = getPlayer(guildId);

        if (command === 'pause' || command === 'resume' || command === 'skip' ||
            command === 'stop' || command === 'volume' ||
            command === 'loop' || command === 'leave') {
            if (!await checkVoice(interaction, player)) return;
        }

        if (command === 'queue') {
            await openQueueDashboard(interaction, player);
        } else if (['pause', 'resume', 'skip', 'stop', 'volume', 'loop', 'leave'].includes(command)) {
            await interaction.deferReply();

            let response;

            if (command === 'pause') {
                await player.pause();
                response = '⏸️ Musik dijeda.';
            } else if (command === 'resume') {
                if (!player.paused) {
                    response = '🤣 Lah, musiknya kan belum dijeda, SUKIII! Santai dulu wkwkwk.';
                } else {
                    await player.resume();
                    response = '▶️ Musik dilanjutkan. Selamat mendengarkan lagi! 🎶';
                }
            } else if (command === 'skip') {
                await player.skip();
                response = '⏭️ Lagu dilewati.';
            } else if (command === 'stop') {
                await player.stopPlaying(true, false);
                await player.setRepeatMode('off');
                response = '⏹️ Musik dihentikan dan antrean dikosongkan.';
            } else if (command === 'volume') {
                const volume = interaction.options.getInteger('angka', true);
                await player.setVolume(volume);
                response = `🔊 Volume diatur ke **${volume}%**.`;
            } else if (command === 'loop') {
                const mode = interaction.options.getString('mode', true);
                await player.setRepeatMode(mode);
                response = `🔁 Mode loop: **${mode}**.`;
            } else if (command === 'leave') {
                await player.stopPlaying(true, false);
                await player.setRepeatMode('off');
                await player.destroy('Perintah leave');
                response = '👋 ZOMA APP keluar dari voice channel.';
            }

            await interaction.editReply(response);
        }
    } catch (error) {
        console.error('[INTERACTION ERROR]', error);

        const message =
            '😭 **SABAR SUKIII !!!**\\n' +
            'Waduh, ZOMA lagi ngambek bentar nih wkwkwk.\\n' +
            'Coba lagi ya, jangan panik dulu! 🎩';
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
