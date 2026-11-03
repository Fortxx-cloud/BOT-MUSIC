import os
import asyncio
import discord
import wavelink

from datetime import timedelta
from dotenv import load_dotenv
from discord import app_commands
from discord.ext import commands

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
LAVALINK_URI = os.getenv("LAVALINK_URI")
LAVALINK_PASSWORD = os.getenv("LAVALINK_PASSWORD")

COLOR = 0x8B0000
BRAND = "ZOMA APP 🎩"

loop_modes = {}
current_requesters = {}
track_advance_locks = {}
music_notice_channels = {}


def duration(ms):
    if ms is None:
        return "Unknown"
    try:
        seconds = max(0, int(ms / 1000))
    except (TypeError, ValueError):
        return "Unknown"
    return str(timedelta(seconds=seconds))


def get_player(interaction):
    if not interaction.guild:
        return None
    return interaction.guild.voice_client


def make_embed(title, description="", color=COLOR):
    embed = discord.Embed(
        title=title,
        description=description,
        color=color
    )
    embed.set_footer(text=BRAND)
    return embed


def track_embed(track, requester=None):
    embed = make_embed(
        "🎵 NOW PLAYING",
        f"**[{track.title}]({track.uri})**"
    )

    embed.add_field(
        name="🎤 Artist",
        value=str(track.author)[:100],
        inline=True
    )

    embed.add_field(
        name="⏱️ Duration",
        value=duration(track.length),
        inline=True
    )

    if requester:
        embed.add_field(
            name="👤 Requested by",
            value=requester.mention,
            inline=True
        )

    artwork = getattr(track, "artwork", None)
    if artwork:
        embed.set_thumbnail(url=artwork)

    return embed


async def check_voice(interaction, player):
    if not interaction.user.voice:
        await interaction.response.send_message(
            "❌ Masuk voice channel terlebih dahulu.",
            ephemeral=True
        )
        return False

    if not player:
        await interaction.response.send_message(
            "❌ Bot belum berada di voice channel.",
            ephemeral=True
        )
        return False

    if player.channel != interaction.user.voice.channel:
        await interaction.response.send_message(
            "❌ Lu harus berada di voice channel yang sama dengan bot.",
            ephemeral=True
        )
        return False

    return True


async def connect_player(interaction):
    if not interaction.user.voice:
        raise ValueError("Masuk voice channel terlebih dahulu.")

    channel = interaction.user.voice.channel
    player = get_player(interaction)

    if not player:
        player = await channel.connect(cls=wavelink.Player)

    elif player.channel != channel:
        await player.move_to(channel)

    # Permanent, subtle clarity EQ: applied automatically whenever the
    # player connects. This shapes tone; it cannot repair a poor source or
    # network/voice packet loss.
    filters = player.filters
    filters.equalizer.set(
        bands=[
            {"band": 0, "gain": 0.02},
            {"band": 1, "gain": 0.04},
            {"band": 2, "gain": 0.06},
            {"band": 3, "gain": 0.05},
            {"band": 4, "gain": 0.02},
            {"band": 5, "gain": -0.02},
            {"band": 6, "gain": -0.03},
            {"band": 7, "gain": -0.02},
            {"band": 8, "gain": 0.01},
            {"band": 9, "gain": 0.03},
            {"band": 10, "gain": 0.04},
            {"band": 11, "gain": 0.04},
            {"band": 12, "gain": 0.02},
            {"band": 13, "gain": 0.00},
            {"band": 14, "gain": -0.02},
        ]
    )
    await player.set_filters(filters)

    # Wavelink AutoPlay manages track transitions. Never manually start
    # another track from on_wavelink_track_end while AutoPlay is enabled.
    player.autoplay = wavelink.AutoPlayMode.partial
    if player.queue.mode is None:
        player.queue.mode = wavelink.QueueMode.normal
    loop_modes.setdefault(interaction.guild.id, "off")
    return player


async def add_track(player, track, requester, text_channel=None):
    track.extras = {"requester_id": requester.id}
    if player.guild and text_channel:
        music_notice_channels[player.guild.id] = text_channel.id
    await player.queue.put_wait(track)
    player.autoplay = wavelink.AutoPlayMode.partial

    if not player.playing and not player.paused:
        next_track = player.queue.get()
        await player.play(next_track, populate=False)



class SearchSelect(discord.ui.Select):
    def __init__(self, tracks, requester):
        self.tracks = tracks
        self.requester = requester

        options = []

        for index, track in enumerate(tracks):
            title = str(track.title)[:95]
            artist = str(track.author)[:90]

            options.append(
                discord.SelectOption(
                    label=title,
                    description=f"{index + 1}. {artist}"[:100],
                    value=str(index),
                    emoji="🎵"
                )
            )

        super().__init__(
            placeholder="Pilih lagu yang ingin diputar...",
            min_values=1,
            max_values=1,
            options=options
        )

    async def callback(self, interaction):
        if interaction.user.id != self.requester.id:
            return await interaction.response.send_message(
                "❌ Menu ini hanya bisa digunakan oleh orang yang mencari lagu.",
                ephemeral=True
            )

        try:
            player = await connect_player(interaction)
            track = self.tracks[int(self.values[0])]

            await add_track(player, track, interaction.user, interaction.channel)

            embed = make_embed(
                "✅ LAGU BERHASIL DITAMBAHKAN",
                f"**[{track.title}]({track.uri})**\n"
                f"🎤 {track.author}\n"
                f"⏱️ {duration(track.length)}"
            )

            await interaction.response.edit_message(
                embed=embed,
                view=None
            )

        except Exception as error:
            await interaction.response.send_message(
                f"❌ Gagal menambahkan lagu: {error}",
                ephemeral=True
            )


class SearchView(discord.ui.View):
    def __init__(self, tracks, requester):
        super().__init__(timeout=120)
        self.add_item(SearchSelect(tracks, requester))


class PlayerView(discord.ui.View):
    def __init__(self):
        super().__init__(timeout=None)

    async def interaction_player(self, interaction):
        player = get_player(interaction)

        if not await check_voice(interaction, player):
            return None

        return player

    @discord.ui.button(
        label="Pause",
        emoji="⏸️",
        style=discord.ButtonStyle.secondary
    )
    async def pause_button(self, interaction, button):
        player = await self.interaction_player(interaction)
        if not player:
            return

        if not player.playing:
            return await interaction.response.send_message(
                "Tidak ada lagu yang sedang diputar.",
                ephemeral=True
            )

        await player.pause(True)
        await interaction.response.send_message(
            "⏸️ Musik dijeda.",
            ephemeral=True
        )

    @discord.ui.button(
        label="Resume",
        emoji="▶️",
        style=discord.ButtonStyle.success
    )
    async def resume_button(self, interaction, button):
        player = await self.interaction_player(interaction)
        if not player:
            return

        if not player.paused:
            return await interaction.response.send_message(
                "Musik tidak sedang dijeda.",
                ephemeral=True
            )

        await player.pause(False)
        await interaction.response.send_message(
            "▶️ Musik dilanjutkan.",
            ephemeral=True
        )

    @discord.ui.button(
        label="Skip",
        emoji="⏭️",
        style=discord.ButtonStyle.primary
    )
    async def skip_button(self, interaction, button):
        player = await self.interaction_player(interaction)
        if not player:
            return

        if not player.playing:
            return await interaction.response.send_message(
                "Tidak ada musik untuk dilewati.",
                ephemeral=True
            )

        await player.skip()
        await interaction.response.send_message(
            "⏭️ Lagu dilewati.",
            ephemeral=True
        )

    @discord.ui.button(
        label="Stop",
        emoji="⏹️",
        style=discord.ButtonStyle.danger
    )
    async def stop_button(self, interaction, button):
        player = await self.interaction_player(interaction)
        if not player:
            return

        player.queue.clear()
        player.auto_queue.clear()
        player.queue.mode = wavelink.QueueMode.normal
        player.autoplay = wavelink.AutoPlayMode.disabled
        loop_modes[interaction.guild.id] = "off"
        await player.stop()

        await interaction.response.send_message(
            "⏹️ Musik dihentikan dan antrean dibersihkan.",
            ephemeral=True
        )


class BlackEmpireMusic(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()

        super().__init__(
            command_prefix="!",
            intents=intents
        )

    async def setup_hook(self):
        if not LAVALINK_URI or not LAVALINK_PASSWORD:
            raise RuntimeError(
                "LAVALINK_URI atau LAVALINK_PASSWORD belum diatur."
            )

        node = wavelink.Node(
            uri=LAVALINK_URI,
            password=LAVALINK_PASSWORD,
            identifier="BLACK-EMPIRE"
        )

        await wavelink.Pool.connect(
            client=self,
            nodes=[node]
        )

        await self.tree.sync()

        print("Slash commands berhasil disinkronkan.")

    async def on_ready(self):
        print("ZOMA APP ONLINE 🎩")
        print(f"Bot: {self.user}")

        await self.change_presence(
            activity=discord.Activity(
                type=discord.ActivityType.listening,
                name="ZOMA APP 🎩 | /search"
            )
        )

    async def on_wavelink_node_ready(self, payload):
        print(
            f"NodeLink CONNECTED: {payload.node.identifier}"
        )

    async def _music_notice_channel(self, guild_id):
        channel_id = music_notice_channels.get(guild_id)
        if not channel_id:
            return None
        channel = self.get_channel(channel_id)
        if channel is None:
            try:
                channel = await self.fetch_channel(channel_id)
            except Exception as error:
                print(f"[MUSIC NOTICE ERROR] Gagal mengambil channel: {error}")
        return channel

    async def on_wavelink_track_start(self, payload):
        player = payload.player
        track = payload.track
        if not player or not track:
            return

        title = getattr(track, "title", "Unknown")
        print(f"[MUSIC START] {title}")

        guild_id = getattr(getattr(player, "guild", None), "id", None)
        if guild_id is None:
            return

        channel = await self._music_notice_channel(guild_id)
        if channel is None:
            print(f"[MUSIC NOTICE] Channel belum tersedia untuk {guild_id}")
            return

        requester_id = None
        try:
            requester_id = track.extras.get("requester_id")
        except (AttributeError, TypeError):
            pass

        description = f"**{title}**"
        author = getattr(track, "author", None)
        if author:
            description += f"\\n🎤 {author}"

        uri = getattr(track, "uri", None)
        if uri:
            description = f"[{description}]({uri})"

        if requester_id:
            description += f"\\n🙋 Diminta oleh <@{requester_id}>"

        embed = discord.Embed(
            title="🎶 ZOMA SEKARANG MEMUTAR",
            description=description,
            color=discord.Color.gold()
        )
        try:
            await channel.send(embed=embed)
        except Exception as error:
            print(f"[MUSIC NOTICE ERROR] Gagal kirim notifikasi mulai: {error}")

    async def on_wavelink_track_end(self, payload):
        player = payload.player
        track = payload.track
        if not player or not track:
            return

        reason = getattr(payload.reason, "name", str(payload.reason)).lower()
        title = getattr(track, "title", "Unknown")
        print(
            f"[MUSIC END] {title} | reason={reason} "
            f"| queue={len(player.queue)} "
            f"| autoplay={player.autoplay.name}"
        )

        if reason != "finished":
            return

        guild_id = getattr(getattr(player, "guild", None), "id", None)
        if guild_id is None:
            return

        channel = await self._music_notice_channel(guild_id)
        if channel is None:
            return

        try:
            await channel.send(
                f"🏁 **LAGU SELESAI**\n**{title}**"
            )
        except Exception as error:
            print(f"[MUSIC NOTICE ERROR] Gagal kirim notifikasi selesai: {error}")

    async def on_wavelink_track_exception(self, payload):
        print(f"[MUSIC EXCEPTION] {payload.exception}")

    async def on_wavelink_track_stuck(self, payload):
        print(f"[MUSIC STUCK] {getattr(payload.track, 'title', 'Unknown')}")


bot = BlackEmpireMusic()


# SEARCH
@bot.tree.command(
    name="search",
    description="Cari lagu dengan 5 pilihan"
)
@app_commands.describe(query="Judul lagu atau nama artis")
async def search(interaction: discord.Interaction, query: str):
    await interaction.response.defer()

    try:
        tracks = await wavelink.Playable.search(query)

        if not tracks:
            return await interaction.followup.send(
                embed=make_embed(
                    "🔎 LAGU TIDAK DITEMUKAN",
                    "Coba gunakan judul atau nama artis yang berbeda."
                )
            )

        if isinstance(tracks, wavelink.Playlist):
            tracks = tracks.tracks

        tracks = list(tracks)[:5]

        description = ""

        for index, track in enumerate(tracks, start=1):
            description += (
                f"**{index}.** {track.title[:75]}\n"
                f"   🎤 {track.author} • ⏱️ {duration(track.length)}\n\n"
            )

        embed = make_embed(
            "🔎 ZOMA MUSIC SEARCH",
            f"**Hasil pencarian:** `{query}`\n\n{description}"
        )

        artwork = getattr(tracks[0], "artwork", None)
        if artwork:
            embed.set_thumbnail(url=artwork)

        embed.add_field(
            name="🎧 PILIH LAGU",
            value="Gunakan menu pilihan di bawah untuk memutar lagu.",
            inline=False
        )

        await interaction.followup.send(
            embed=embed,
            view=SearchView(tracks, interaction.user)
        )

    except Exception as error:
        await interaction.followup.send(
            f"❌ Search gagal: {error}"
        )


# PLAY
@bot.tree.command(
    name="play",
    description="Putar lagu langsung"
)
@app_commands.describe(query="Judul lagu atau URL")
async def play(interaction: discord.Interaction, query: str):
    await interaction.response.defer()

    try:
        player = await connect_player(interaction)
        tracks = await wavelink.Playable.search(query)

        if not tracks:
            return await interaction.followup.send(
                "❌ Lagu tidak ditemukan."
            )

        if isinstance(tracks, wavelink.Playlist):
            selected = tracks.tracks
            if player.guild and interaction.channel:
                music_notice_channels[player.guild.id] = interaction.channel.id
            for track in selected:
                track.extras = {"requester_id": interaction.user.id}
            await player.queue.put_wait(selected)
            player.autoplay = wavelink.AutoPlayMode.partial
            if not player.playing and not player.paused and player.queue:
                await player.play(player.queue.get(), populate=False)

            return await interaction.followup.send(
                f"✅ Playlist **{tracks.name}** ditambahkan."
            )

        track = tracks[0]
        await add_track(player, track, interaction.user, interaction.channel)

        await interaction.followup.send(
            embed=track_embed(track, interaction.user),
            view=PlayerView()
        )

    except Exception as error:
        await interaction.followup.send(
            f"❌ Gagal memutar lagu: {error}"
        )


# PAUSE
@bot.tree.command(name="pause", description="Jeda musik")
async def pause(interaction: discord.Interaction):
    player = get_player(interaction)

    if not await check_voice(interaction, player):
        return

    if not player.playing:
        return await interaction.response.send_message(
            "Tidak ada musik yang diputar.",
            ephemeral=True
        )

    await player.pause(True)
    await interaction.response.send_message("⏸️ Musik dijeda.")


# RESUME
@bot.tree.command(name="resume", description="Lanjutkan musik")
async def resume(interaction: discord.Interaction):
    player = get_player(interaction)

    if not await check_voice(interaction, player):
        return

    if not player.paused:
        return await interaction.response.send_message(
            "Musik tidak sedang dijeda.",
            ephemeral=True
        )

    await player.pause(False)
    await interaction.response.send_message("▶️ Musik dilanjutkan.")


# SKIP
@bot.tree.command(name="skip", description="Lewati lagu")
async def skip(interaction: discord.Interaction):
    player = get_player(interaction)

    if not await check_voice(interaction, player):
        return

    if not player.playing:
        return await interaction.response.send_message(
            "Tidak ada musik.",
            ephemeral=True
        )

    await player.skip()
    await interaction.response.send_message("⏭️ Lagu dilewati.")


# STOP
@bot.tree.command(name="stop", description="Hentikan musik")
async def stop(interaction: discord.Interaction):
    player = get_player(interaction)

    if not await check_voice(interaction, player):
        return

    player.queue.clear()
    player.auto_queue.clear()
    player.queue.mode = wavelink.QueueMode.normal
    player.autoplay = wavelink.AutoPlayMode.disabled
    loop_modes[interaction.guild.id] = "off"
    await player.stop()

    await interaction.response.send_message(
        "⏹️ Musik dihentikan."
    )



# QUEUE MANAGER DASHBOARD

QUEUE_PAGE_SIZE = 8


def queue_dashboard_embed(player, page=0):
    tracks = list(player.queue)
    total = len(tracks)
    pages = max(1, (total + QUEUE_PAGE_SIZE - 1) // QUEUE_PAGE_SIZE)
    page = max(0, min(page, pages - 1))

    embed = make_embed(
        "🎩 ZOMA APP • QUEUE MANAGER",
        "━━━━━━━━━━━━━━━━━━━━━━━━"
    )

    current = player.current

    if current:
        embed.add_field(
            name="▶️ NOW PLAYING",
            value=(
                f"**[{current.title}]({current.uri})**\n"
                f"🎤 {current.author}\n"
                f"⏱️ {duration(current.length)}"
            )[:1024],
            inline=False
        )
    else:
        embed.add_field(
            name="▶️ NOW PLAYING",
            value="Belum ada lagu yang diputar.",
            inline=False
        )

    if tracks:
        first = page * QUEUE_PAGE_SIZE
        selected = tracks[first:first + QUEUE_PAGE_SIZE]

        lines = []
        for index, track in enumerate(selected, start=first + 1):
            lines.append(
                f"**{index}.** [{track.title[:75]}]({track.uri})\n"
                f"　🎤 {track.author[:60]} • `{duration(track.length)}`"
            )

        embed.add_field(
            name=f"📜 UP NEXT • {total} LAGU",
            value="\n\n".join(lines)[:1024],
            inline=False
        )
    else:
        embed.add_field(
            name="📜 UP NEXT",
            value="Antrean masih kosong.",
            inline=False
        )

    mode = loop_modes.get(player.guild.id, "off").upper()

    known_durations = [
        track.length for track in tracks
        if isinstance(getattr(track, "length", None), (int, float))
    ]
    total_ms = sum(known_durations)
    total_time = (
        str(timedelta(seconds=int(total_ms // 1000)))
        if len(known_durations) == len(tracks)
        else "Unknown"
    )

    embed.add_field(
        name="🎧 TOTAL QUEUE",
        value=f"{total} lagu",
        inline=True
    )
    embed.add_field(
        name="⏱️ QUEUE DURATION",
        value=total_time,
        inline=True
    )
    embed.add_field(
        name="🔁 LOOP MODE",
        value=mode,
        inline=True
    )

    embed.set_footer(
        text=f"ZOMA APP 🎩 • Halaman {page + 1}/{pages}"
    )

    if current:
        artwork = getattr(current, "artwork", None)
        if artwork:
            embed.set_thumbnail(url=artwork)

    return embed, page, pages


class QueueRemoveSelect(discord.ui.Select):
    def __init__(self, dashboard):
        self.dashboard = dashboard
        tracks = list(dashboard.player.queue)

        start = dashboard.page * QUEUE_PAGE_SIZE
        selected = tracks[start:start + QUEUE_PAGE_SIZE]

        options = [
            discord.SelectOption(
                label=f"{start + index + 1}. {track.title[:85]}",
                value=str(start + index),
                description=str(track.author)[:100],
                emoji="🗑️"
            )
            for index, track in enumerate(selected)
        ]

        super().__init__(
            placeholder="🗑️ Pilih lagu untuk dihapus...",
            min_values=1,
            max_values=1,
            options=options,
            row=0
        )

    async def callback(self, interaction):
        if not await self.dashboard.authorized(interaction):
            return

        index = int(self.values[0])

        try:
            tracks = list(self.dashboard.player.queue)

            if index >= len(tracks):
                return await interaction.response.send_message(
                    "Lagu sudah tidak ada di antrean. Refresh dashboard.",
                    ephemeral=True
                )

            removed = tracks[index]
            self.dashboard.player.queue.delete(index)

            await self.dashboard.refresh(interaction)

            await interaction.followup.send(
                f"🗑️ Dihapus: **{removed.title}**",
                ephemeral=True
            )

        except Exception as error:
            await interaction.response.send_message(
                f"Gagal menghapus lagu: {error}",
                ephemeral=True
            )


class QueueClearConfirm(discord.ui.View):
    def __init__(self, dashboard):
        super().__init__(timeout=30)
        self.dashboard = dashboard

    @discord.ui.button(
        label="Ya, bersihkan",
        emoji="🧹",
        style=discord.ButtonStyle.danger
    )
    async def confirm(self, interaction, button):
        if not await self.dashboard.authorized(interaction):
            return

        self.dashboard.player.queue.clear()

        await interaction.response.edit_message(
            content="✅ Antrean berhasil dibersihkan.",
            view=None
        )

        try:
            embed = self.dashboard.build_embed()
            self.dashboard.rebuild()
            if self.dashboard.message:
                await self.dashboard.message.edit(
                    embed=embed,
                    view=self.dashboard
                )
        except discord.HTTPException as error:
            print(f"[QUEUE DASHBOARD] Gagal refresh setelah clear: {error}")

    @discord.ui.button(
        label="Batal",
        emoji="❌",
        style=discord.ButtonStyle.secondary
    )
    async def cancel(self, interaction, button):
        await interaction.response.edit_message(
            content="Pembersihan antrean dibatalkan.",
            view=None
        )


class QueueDashboard(discord.ui.View):
    def __init__(self, player, requester, page=0):
        super().__init__(timeout=300)

        self.player = player
        self.requester = requester
        self.page = page
        self.message = None
        self.pages = max(
            1,
            (len(player.queue) + QUEUE_PAGE_SIZE - 1) // QUEUE_PAGE_SIZE
        )
        self.rebuild()

    def build_embed(self):
        embed, self.page, self.pages = queue_dashboard_embed(
            self.player,
            self.page
        )
        return embed

    def rebuild(self):
        self.clear_items()
        total = len(self.player.queue)
        self.pages = max(
            1,
            (total + QUEUE_PAGE_SIZE - 1) // QUEUE_PAGE_SIZE
        )
        self.page = max(0, min(self.page, self.pages - 1))

        if total:
            self.add_item(QueueRemoveSelect(self))

        previous = discord.ui.Button(
            label="Prev",
            emoji="◀️",
            style=discord.ButtonStyle.secondary,
            disabled=self.page <= 0,
            row=1
        )
        previous.callback = self.previous_page
        self.add_item(previous)

        next_button = discord.ui.Button(
            label="Next",
            emoji="▶️",
            style=discord.ButtonStyle.secondary,
            disabled=self.page >= self.pages - 1,
            row=1
        )
        next_button.callback = self.next_page
        self.add_item(next_button)

        shuffle = discord.ui.Button(
            label="Shuffle",
            emoji="🔀",
            style=discord.ButtonStyle.primary,
            row=1
        )
        shuffle.callback = self.shuffle_queue
        self.add_item(shuffle)

        loop = discord.ui.Button(
            label="Loop",
            emoji="🔁",
            style=discord.ButtonStyle.primary,
            row=1
        )
        loop.callback = self.change_loop
        self.add_item(loop)

        refresh = discord.ui.Button(
            label="Refresh",
            emoji="🔄",
            style=discord.ButtonStyle.secondary,
            row=1
        )
        refresh.callback = self.refresh
        self.add_item(refresh)

        pause = discord.ui.Button(
            label="Pause",
            emoji="⏸️",
            style=discord.ButtonStyle.secondary,
            row=2
        )
        pause.callback = self.pause_music
        self.add_item(pause)

        resume = discord.ui.Button(
            label="Resume",
            emoji="▶️",
            style=discord.ButtonStyle.success,
            row=2
        )
        resume.callback = self.resume_music
        self.add_item(resume)

        skip = discord.ui.Button(
            label="Skip",
            emoji="⏭️",
            style=discord.ButtonStyle.primary,
            row=2
        )
        skip.callback = self.skip_music
        self.add_item(skip)

        clear = discord.ui.Button(
            label="Clear Queue",
            emoji="🧹",
            style=discord.ButtonStyle.danger,
            row=2,
            disabled=len(self.player.queue) == 0
        )
        clear.callback = self.confirm_clear
        self.add_item(clear)

    async def authorized(self, interaction):
        if interaction.user.id != self.requester.id:
            await interaction.response.send_message(
                "❌ Dashboard ini hanya bisa digunakan oleh pembuatnya.",
                ephemeral=True
            )
            return False

        if not interaction.user.voice:
            await interaction.response.send_message(
                "Masuk voice channel terlebih dahulu.",
                ephemeral=True
            )
            return False

        if interaction.user.voice.channel != self.player.channel:
            await interaction.response.send_message(
                "Lu harus berada di voice channel yang sama dengan bot.",
                ephemeral=True
            )
            return False

        if not self.player.connected:
            await interaction.response.send_message(
                "Bot sudah tidak terhubung ke voice channel.",
                ephemeral=True
            )
            return False

        return True

    async def refresh(self, interaction):
        embed = self.build_embed()
        self.rebuild()
        await interaction.response.edit_message(
            embed=embed,
            view=self
        )

    async def previous_page(self, interaction):
        if not await self.authorized(interaction):
            return

        self.page = max(0, self.page - 1)
        await self.refresh(interaction)

    async def next_page(self, interaction):
        if not await self.authorized(interaction):
            return

        self.page += 1
        await self.refresh(interaction)

    async def shuffle_queue(self, interaction):
        if not await self.authorized(interaction):
            return

        if len(self.player.queue) < 2:
            return await interaction.response.send_message(
                "Minimal perlu 2 lagu untuk shuffle.",
                ephemeral=True
            )

        self.player.queue.shuffle()
        await self.refresh(interaction)

    async def change_loop(self, interaction):
        if not await self.authorized(interaction):
            return

        modes = ["off", "track", "queue"]
        current = loop_modes.get(self.player.guild.id, "off")
        next_mode = modes[(modes.index(current) + 1) % len(modes)]

        queue_modes = {
            "off": wavelink.QueueMode.normal,
            "track": wavelink.QueueMode.loop,
            "queue": wavelink.QueueMode.loop_all,
        }
        self.player.queue.mode = queue_modes[next_mode]
        loop_modes[self.player.guild.id] = next_mode
        await self.refresh(interaction)

    async def pause_music(self, interaction):
        if not await self.authorized(interaction):
            return

        if not self.player.playing:
            return await interaction.response.send_message(
                "Tidak ada musik yang sedang diputar.",
                ephemeral=True
            )

        await self.player.pause(True)
        await self.refresh(interaction)

    async def resume_music(self, interaction):
        if not await self.authorized(interaction):
            return

        if not self.player.paused:
            return await interaction.response.send_message(
                "Musik tidak sedang dijeda.",
                ephemeral=True
            )

        await self.player.pause(False)
        await self.refresh(interaction)

    async def skip_music(self, interaction):
        if not await self.authorized(interaction):
            return

        if not self.player.playing:
            return await interaction.response.send_message(
                "Tidak ada musik yang sedang diputar.",
                ephemeral=True
            )

        await self.player.skip()
        await self.refresh(interaction)

    async def confirm_clear(self, interaction):
        if not await self.authorized(interaction):
            return

        if not self.player.queue:
            return await interaction.response.send_message(
                "Antrean sudah kosong.",
                ephemeral=True
            )

        view = QueueClearConfirm(self)
        await interaction.response.send_message(
            "⚠️ Yakin ingin menghapus seluruh antrean?",
            view=view,
            ephemeral=True
        )

        # Keep self.message pointing to the public dashboard message.
        # The ephemeral confirmation is intentionally not stored here.

    async def on_timeout(self):
        for item in self.children:
            item.disabled = True

        if self.message:
            try:
                await self.message.edit(view=self)
            except Exception:
                pass


@bot.tree.command(
    name="queue",
    description="Buka dashboard pengelola antrean musik"
)
async def queue(interaction: discord.Interaction):
    player = get_player(interaction)

    if not player:
        return await interaction.response.send_message(
            "❌ Bot belum berada di voice channel.",
            ephemeral=True
        )

    if not interaction.user.voice:
        return await interaction.response.send_message(
            "❌ Masuk voice channel terlebih dahulu.",
            ephemeral=True
        )

    if interaction.user.voice.channel != player.channel:
        return await interaction.response.send_message(
            "❌ Lu harus berada di voice channel yang sama dengan bot.",
            ephemeral=True
        )

    view = QueueDashboard(player, interaction.user)

    await interaction.response.send_message(
        embed=view.build_embed(),
        view=view
    )

    view.message = await interaction.original_response()


# VOLUME
@bot.tree.command(name="volume", description="Atur volume musik")
@app_commands.describe(level="Volume 1 sampai 100")
async def volume(interaction: discord.Interaction, level: int):
    player = get_player(interaction)

    if not await check_voice(interaction, player):
        return

    if not 1 <= level <= 100:
        return await interaction.response.send_message(
            "Volume harus antara 1 sampai 100.",
            ephemeral=True
        )

    await player.set_volume(level)

    await interaction.response.send_message(
        f"🔊 Volume sekarang **{level}%**."
    )


# LOOP
@bot.tree.command(name="loop", description="Atur mode pengulangan")
@app_commands.choices(mode=[
    app_commands.Choice(name="Off", value="off"),
    app_commands.Choice(name="Track", value="track"),
    app_commands.Choice(name="Queue", value="queue")
])
async def loop(
    interaction: discord.Interaction,
    mode: app_commands.Choice[str]
):
    player = get_player(interaction)

    if not await check_voice(interaction, player):
        return

    queue_modes = {
        "off": wavelink.QueueMode.normal,
        "track": wavelink.QueueMode.loop,
        "queue": wavelink.QueueMode.loop_all,
    }
    player.queue.mode = queue_modes[mode.value]
    loop_modes[interaction.guild.id] = mode.value

    await interaction.response.send_message(
        f"🔁 Mode loop diubah menjadi **{mode.name}**."
    )


# LEAVE
@bot.tree.command(name="leave", description="Keluarkan bot dari voice")
async def leave(interaction: discord.Interaction):
    player = get_player(interaction)

    if not await check_voice(interaction, player):
        return

    player.queue.clear()
    player.auto_queue.clear()
    player.queue.mode = wavelink.QueueMode.normal
    player.autoplay = wavelink.AutoPlayMode.disabled
    loop_modes[interaction.guild.id] = "off"
    await player.disconnect()

    await interaction.response.send_message(
        "👋 ZOMA APP keluar dari voice channel."
    )


if not TOKEN:
    raise RuntimeError("DISCORD_TOKEN belum diatur.")

bot.run(TOKEN)
