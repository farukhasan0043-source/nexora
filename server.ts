import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { DB } from './server/db.ts';
import type { Post, Comment, Notification, ContentReport, ContactSubmission, LinkMetadata } from './src/types/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper to get or simulate the logged-in user from headers
function getAuthenticatedUser(req: express.Request) {
  const authHeader = req.headers.authorization;
  const db = DB.getInstance().getData();
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.replace('Bearer ', '').trim();
    // token is either a userId or username for easy deterministic auth
    const matched = db.users.find(u => u.id === token || u.username === token);
    if (matched) return matched;
  }
  // Default to Alex Mercer (admin) if header is admin or demo, otherwise return null
  return null;
}

// ----------------------------------------------------
// AUTH ENDPOINTS
// ----------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { credential } = req.body;
  const db = DB.getInstance();
  const data = db.getData();

  const user = data.users.find(u => 
    u.username.toLowerCase() === (credential || '').toLowerCase() || 
    u.email.toLowerCase() === (credential || '').toLowerCase()
  );

  if (!user) {
    // If not found, check if it's the demo quick login
    return res.status(401).json({ error: 'User not found. Please check your username or register.' });
  }

  if (user.isBanned) {
    return res.status(403).json({ error: 'This account has been suspended by Nexora moderation.' });
  }

  res.json({
    token: user.id,
    user
  });
});

app.post('/api/auth/register', (req, res) => {
  const { username, name, email, bio, avatar } = req.body;
  if (!username || !email || !name) {
    return res.status(400).json({ error: 'Username, name, and email are required.' });
  }

  const db = DB.getInstance();
  const data = db.getData();

  const existing = data.users.find(u => 
    u.username.toLowerCase() === username.toLowerCase() || 
    u.email.toLowerCase() === email.toLowerCase()
  );

  if (existing) {
    return res.status(409).json({ error: 'A user with that username or email already exists.' });
  }

  const newUser = {
    id: `user_${Date.now()}`,
    username: username.toLowerCase().replace(/[^a-z0-9_]/g, ''),
    name,
    email,
    role: 'user' as const,
    avatar: avatar || '/src/assets/images/avatar_marcus_1790658508240.jpg',
    banner: '/src/assets/images/nexora_hero_curation_1790658482827.jpg',
    bio: bio || 'Explorer and creator on Nexora.',
    followersCount: 0,
    followingCount: 0,
    postsCount: 0,
    joinedDate: new Date().toISOString()
  };

  data.users.push(newUser);
  db.commit();

  res.status(201).json({
    token: newUser.id,
    user: newUser
  });
});

app.get('/api/auth/me', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ user });
});

// ----------------------------------------------------
// POSTS CRUD & INTERACTIONS
// ----------------------------------------------------
app.get('/api/posts', (req, res) => {
  const { type, tag, author, search, sort = 'latest', featured } = req.query;
  const db = DB.getInstance();
  const data = db.getData();

  let posts = [...data.posts];

  if (type && type !== 'all') {
    posts = posts.filter(p => p.type === type);
  }

  if (tag) {
    posts = posts.filter(p => p.tags.some(t => t.toLowerCase() === (tag as string).toLowerCase()));
  }

  if (author) {
    posts = posts.filter(p => p.authorUsername.toLowerCase() === (author as string).toLowerCase());
  }

  if (featured === 'true') {
    posts = posts.filter(p => p.featured || p.isPinned);
  }

  if (search) {
    const q = (search as string).toLowerCase();
    posts = posts.filter(p => 
      (p.title && p.title.toLowerCase().includes(q)) || 
      p.content.toLowerCase().includes(q) ||
      p.tags.some(t => t.toLowerCase().includes(q)) ||
      p.authorName.toLowerCase().includes(q) ||
      p.authorUsername.toLowerCase().includes(q)
    );
  }

  // Sort
  if (sort === 'trending') {
    posts.sort((a, b) => (b.likesCount * 3 + b.commentsCount * 2 + b.repostsCount * 4) - (a.likesCount * 3 + a.commentsCount * 2 + a.repostsCount * 4));
  } else if (sort === 'popular') {
    posts.sort((a, b) => b.likesCount - a.likesCount);
  } else {
    // latest
    posts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  res.json(posts);
});

app.get('/api/posts/:id', (req, res) => {
  const db = DB.getInstance();
  const data = db.getData();
  const post = data.posts.find(p => p.id === req.params.id);

  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }

  // increment view count
  post.viewsCount = (post.viewsCount || 0) + 1;
  db.commit();

  const comments = data.comments.filter(c => c.postId === post.id);
  const author = data.users.find(u => u.id === post.authorId);

  res.json({
    post,
    author,
    comments
  });
});

app.post('/api/posts', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'You must be logged in to create a post.' });
  }

  const { title, content, type, mediaUrls, linkMetadata, tags, aspectRatio, visibility } = req.body;
  if (!content && (!mediaUrls || mediaUrls.length === 0) && !linkMetadata) {
    return res.status(400).json({ error: 'Post must contain text, media, or a valid link.' });
  }

  const db = DB.getInstance();
  const data = db.getData();

  const newPost: Post = {
    id: `post_${Date.now()}`,
    authorId: user.id,
    authorUsername: user.username,
    authorName: user.name,
    authorAvatar: user.avatar,
    isVerified: user.isVerified,
    role: user.role,
    title: title || undefined,
    content: content || '',
    type: type || 'text',
    mediaUrls: mediaUrls || [],
    aspectRatio: aspectRatio || '16:9',
    linkMetadata: linkMetadata || undefined,
    tags: Array.isArray(tags) ? tags : [],
    likesCount: 0,
    likedBy: [],
    bookmarksCount: 0,
    bookmarkedBy: [],
    repostsCount: 0,
    repostedBy: [],
    commentsCount: 0,
    viewsCount: 1,
    isPinned: false,
    createdAt: new Date().toISOString(),
    visibility: visibility || 'public',
    featured: false
  };

  data.posts.unshift(newPost);
  user.postsCount = (user.postsCount || 0) + 1;
  db.commit();

  res.status(201).json(newPost);
});

app.put('/api/posts/:id', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const post = data.posts.find(p => p.id === req.params.id);

  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }

  if (post.authorId !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { title, content, tags, visibility, isPinned } = req.body;
  if (title !== undefined) post.title = title;
  if (content !== undefined) post.content = content;
  if (tags !== undefined) post.tags = tags;
  if (visibility !== undefined) post.visibility = visibility;
  if (isPinned !== undefined) post.isPinned = isPinned;

  db.commit();
  res.json(post);
});

app.delete('/api/posts/:id', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const index = data.posts.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const post = data.posts[index];
  if (post.authorId !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  data.posts.splice(index, 1);
  // remove associated comments
  data.comments = data.comments.filter(c => c.postId !== post.id);

  const author = data.users.find(u => u.id === post.authorId);
  if (author && author.postsCount > 0) {
    author.postsCount -= 1;
  }

  db.commit();
  res.json({ success: true, message: 'Post deleted successfully.' });
});

// Like toggle
app.post('/api/posts/:id/like', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Please sign in to like posts.' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const post = data.posts.find(p => p.id === req.params.id);

  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const idx = post.likedBy.indexOf(user.id);
  let isLiked = false;
  if (idx > -1) {
    post.likedBy.splice(idx, 1);
    post.likesCount = Math.max(0, post.likesCount - 1);
    isLiked = false;
  } else {
    post.likedBy.push(user.id);
    post.likesCount += 1;
    isLiked = true;

    // Send notification if not own post
    if (post.authorId !== user.id) {
      data.notifications.unshift({
        id: `notif_${Date.now()}`,
        userId: post.authorId,
        actorId: user.id,
        actorUsername: user.username,
        actorName: user.name,
        actorAvatar: user.avatar,
        type: 'like',
        postId: post.id,
        postSnippet: (post.title || post.content || '').slice(0, 40),
        read: false,
        createdAt: new Date().toISOString()
      });
    }
  }

  db.commit();
  res.json({ isLiked, likesCount: post.likesCount });
});

// Bookmark toggle
app.post('/api/posts/:id/bookmark', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Please sign in to bookmark posts.' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const post = data.posts.find(p => p.id === req.params.id);

  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const idx = post.bookmarkedBy.indexOf(user.id);
  let isBookmarked = false;
  if (idx > -1) {
    post.bookmarkedBy.splice(idx, 1);
    post.bookmarksCount = Math.max(0, post.bookmarksCount - 1);
    isBookmarked = false;
  } else {
    post.bookmarkedBy.push(user.id);
    post.bookmarksCount += 1;
    isBookmarked = true;
  }

  db.commit();
  res.json({ isBookmarked, bookmarksCount: post.bookmarksCount });
});

// Repost toggle
app.post('/api/posts/:id/repost', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Please sign in to repost.' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const post = data.posts.find(p => p.id === req.params.id);

  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const idx = post.repostedBy.indexOf(user.id);
  let isReposted = false;
  if (idx > -1) {
    post.repostedBy.splice(idx, 1);
    post.repostsCount = Math.max(0, post.repostsCount - 1);
    isReposted = false;
  } else {
    post.repostedBy.push(user.id);
    post.repostsCount += 1;
    isReposted = true;

    if (post.authorId !== user.id) {
      data.notifications.unshift({
        id: `notif_${Date.now()}`,
        userId: post.authorId,
        actorId: user.id,
        actorUsername: user.username,
        actorName: user.name,
        actorAvatar: user.avatar,
        type: 'repost',
        postId: post.id,
        postSnippet: (post.title || post.content || '').slice(0, 40),
        read: false,
        createdAt: new Date().toISOString()
      });
    }
  }

  db.commit();
  res.json({ isReposted, repostsCount: post.repostsCount });
});

// Report post
app.post('/api/posts/:id/report', (req, res) => {
  const user = getAuthenticatedUser(req);
  const { reason, details } = req.body;

  const db = DB.getInstance();
  const data = db.getData();
  const post = data.posts.find(p => p.id === req.params.id);

  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const newReport: ContentReport = {
    id: `rep_${Date.now()}`,
    postId: post.id,
    postTitle: post.title || post.content.slice(0, 30),
    postAuthor: post.authorUsername,
    reporterId: user ? user.id : 'anon_reporter',
    reporterUsername: user ? user.username : 'anonymous',
    reason: reason || 'inappropriate',
    details: details || 'Flagged by community member.',
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  data.reports.unshift(newReport);
  db.commit();
  res.json({ success: true, message: 'Thank you for reporting. Our moderation team has been notified.' });
});

// Comments
app.post('/api/posts/:id/comments', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Please sign in to comment.' });
  }

  const { content } = req.body;
  if (!content || !content.trim()) {
    return res.status(400).json({ error: 'Comment content cannot be empty.' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const post = data.posts.find(p => p.id === req.params.id);

  if (!post) {
    return res.status(404).json({ error: 'Post not found' });
  }

  const newComment: Comment = {
    id: `comm_${Date.now()}`,
    postId: post.id,
    authorId: user.id,
    authorUsername: user.username,
    authorName: user.name,
    authorAvatar: user.avatar,
    isVerified: user.isVerified,
    content: content.trim(),
    createdAt: new Date().toISOString(),
    likesCount: 0,
    likedBy: []
  };

  data.comments.push(newComment);
  post.commentsCount += 1;

  if (post.authorId !== user.id) {
    data.notifications.unshift({
      id: `notif_${Date.now()}`,
      userId: post.authorId,
      actorId: user.id,
      actorUsername: user.username,
      actorName: user.name,
      actorAvatar: user.avatar,
      type: 'comment',
      postId: post.id,
      postSnippet: newComment.content.slice(0, 40),
      read: false,
      createdAt: new Date().toISOString()
    });
  }

  db.commit();
  res.status(201).json(newComment);
});

app.delete('/api/posts/:postId/comments/:commentId', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const idx = data.comments.findIndex(c => c.id === req.params.commentId);

  if (idx === -1) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  const comment = data.comments[idx];
  if (comment.authorId !== user.id && user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  data.comments.splice(idx, 1);
  const post = data.posts.find(p => p.id === req.params.postId);
  if (post && post.commentsCount > 0) {
    post.commentsCount -= 1;
  }

  db.commit();
  res.json({ success: true });
});

// ----------------------------------------------------
// USERS & PROFILES
// ----------------------------------------------------
app.get('/api/users/:username', (req, res) => {
  const db = DB.getInstance();
  const data = db.getData();
  const user = data.users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());

  if (!user) {
    return res.status(404).json({ error: 'User profile not found.' });
  }

  const posts = data.posts.filter(p => p.authorId === user.id);
  const followers = data.followers.filter(f => f.followingId === user.id).map(f => f.followerId);
  const following = data.followers.filter(f => f.followerId === user.id).map(f => f.followingId);

  res.json({
    user,
    posts,
    followers,
    following
  });
});

app.put('/api/users/:username', (req, res) => {
  const authUser = getAuthenticatedUser(req);
  if (!authUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const user = data.users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.id !== authUser.id && authUser.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { name, bio, location, website, socialLinks, avatar, banner } = req.body;
  if (name !== undefined) user.name = name;
  if (bio !== undefined) user.bio = bio;
  if (location !== undefined) user.location = location;
  if (website !== undefined) user.website = website;
  if (socialLinks !== undefined) user.socialLinks = socialLinks;
  if (avatar !== undefined) user.avatar = avatar;
  if (banner !== undefined) user.banner = banner;

  db.commit();
  res.json(user);
});

// Follow toggle
app.post('/api/users/:username/follow', (req, res) => {
  const authUser = getAuthenticatedUser(req);
  if (!authUser) {
    return res.status(401).json({ error: 'Please sign in to follow creators.' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const targetUser = data.users.find(u => u.username.toLowerCase() === req.params.username.toLowerCase());

  if (!targetUser) {
    return res.status(404).json({ error: 'Target user not found.' });
  }

  if (targetUser.id === authUser.id) {
    return res.status(400).json({ error: 'You cannot follow yourself.' });
  }

  const existingIdx = data.followers.findIndex(f => f.followerId === authUser.id && f.followingId === targetUser.id);
  let isFollowing = false;

  if (existingIdx > -1) {
    data.followers.splice(existingIdx, 1);
    targetUser.followersCount = Math.max(0, targetUser.followersCount - 1);
    authUser.followingCount = Math.max(0, authUser.followingCount - 1);
    isFollowing = false;
  } else {
    data.followers.push({ followerId: authUser.id, followingId: targetUser.id });
    targetUser.followersCount += 1;
    authUser.followingCount += 1;
    isFollowing = true;

    data.notifications.unshift({
      id: `notif_${Date.now()}`,
      userId: targetUser.id,
      actorId: authUser.id,
      actorUsername: authUser.username,
      actorName: authUser.name,
      actorAvatar: authUser.avatar,
      type: 'follow',
      read: false,
      createdAt: new Date().toISOString()
    });
  }

  db.commit();
  res.json({ isFollowing, followersCount: targetUser.followersCount });
});

// ----------------------------------------------------
// NOTIFICATIONS
// ----------------------------------------------------
app.get('/api/notifications', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const notifs = data.notifications.filter(n => n.userId === user.id);

  res.json(notifs);
});

app.post('/api/notifications/read-all', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  data.notifications.forEach(n => {
    if (n.userId === user.id) {
      n.read = true;
    }
  });

  db.commit();
  res.json({ success: true });
});

// ----------------------------------------------------
// SEARCH & EXPLORE
// ----------------------------------------------------
app.get('/api/search', (req, res) => {
  const q = ((req.query.q as string) || '').toLowerCase().trim();
  const db = DB.getInstance();
  const data = db.getData();

  if (!q) {
    return res.json({ posts: [], users: [], tags: [] });
  }

  const matchedPosts = data.posts.filter(p =>
    (p.title && p.title.toLowerCase().includes(q)) ||
    p.content.toLowerCase().includes(q) ||
    p.tags.some(t => t.toLowerCase().includes(q))
  );

  const matchedUsers = data.users.filter(u =>
    u.username.toLowerCase().includes(q) ||
    u.name.toLowerCase().includes(q) ||
    u.bio.toLowerCase().includes(q)
  );

  const tagCounts: { [tag: string]: number } = {};
  data.posts.forEach(p => {
    p.tags.forEach(t => {
      if (t.toLowerCase().includes(q)) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    });
  });

  const matchedTags = Object.entries(tagCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  res.json({
    posts: matchedPosts,
    users: matchedUsers,
    tags: matchedTags
  });
});

app.get('/api/explore', (_req, res) => {
  const db = DB.getInstance();
  const data = db.getData();

  // Trending tags
  const tagCounts: { [tag: string]: number } = {};
  data.posts.forEach(p => {
    p.tags.forEach(t => {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    });
  });

  const trendingTags = Object.entries(tagCounts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Featured Creators
  const creators = data.users
    .filter(u => u.role === 'creator' || u.isVerified)
    .slice(0, 5);

  // Curated collections
  const collections = [
    {
      id: 'col_visual',
      title: 'Architectural & Spatial Geometry',
      description: 'Concrete monoliths, high-contrast light, and deliberate minimalism.',
      postsCount: data.posts.filter(p => p.type === 'photo').length,
      cover: '/src/assets/images/post_architecture_1790658519051.jpg'
    },
    {
      id: 'col_essays',
      title: 'Essays & Calm Computing',
      description: 'Long-form commentary on independent software, typography, and digital sanity.',
      postsCount: data.posts.filter(p => p.type === 'text').length,
      cover: '/src/assets/images/nexora_hero_curation_1790658482827.jpg'
    },
    {
      id: 'col_cinema',
      title: 'Cinematic Motion & Aerial Landscapes',
      description: 'Anamorphic expeditions across raw horizons and Scandinavian fjords.',
      postsCount: data.posts.filter(p => p.type === 'video' || p.type === 'video_link').length,
      cover: '/src/assets/images/post_cinematic_scenery_1790658529788.jpg'
    }
  ];

  res.json({
    trendingTags,
    creators,
    collections,
    featuredPosts: data.posts.filter(p => p.featured || p.likesCount > 150)
  });
});

// ----------------------------------------------------
// LINK METADATA PARSER / SIMULATOR
// ----------------------------------------------------
app.post('/api/metadata/link-preview', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    const host = parsed.hostname.toLowerCase();

    let platform: LinkMetadata['platform'] = 'generic';
    let title = `${parsed.hostname.replace('www.', '')} | Shared Resource`;
    let description = 'Curated link shared on Nexora platform.';
    let image = '/src/assets/images/nexora_hero_curation_1790658482827.jpg';

    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      platform = 'youtube';
      title = 'Nordic Horizon Study | 4K Anamorphic Video';
      description = 'Watch high-fidelity cinematic video in native 4K with spatial audio.';
      image = '/src/assets/images/post_cinematic_scenery_1790658529788.jpg';
    } else if (host.includes('vimeo.com')) {
      platform = 'vimeo';
      title = 'Vimeo Premiere Feature Documentary';
      description = 'Independent production streamed in cinema-grade compression.';
      image = '/src/assets/images/post_cinematic_scenery_1790658529788.jpg';
    } else if (host.includes('twitter.com') || host.includes('x.com')) {
      platform = 'twitter';
      title = 'Thread on X / Twitter';
      description = 'Detailed breakdown of design architecture and independent publishing.';
    } else if (host.includes('github.com')) {
      platform = 'github';
      title = 'GitHub Repository | Open Source Tools';
      description = 'Fast, accessible, and type-safe infrastructure designed for creative technologists.';
    } else if (host.includes('instagram.com')) {
      platform = 'instagram';
      title = 'Visual Portfolio on Instagram';
      description = 'Daily captures of architectural textures and natural daylight.';
    }

    const metadata: LinkMetadata = {
      url: parsed.href,
      title,
      description,
      domain: parsed.hostname.replace('www.', ''),
      image,
      platform
    };

    res.json(metadata);
  } catch (err) {
    res.status(400).json({ error: 'Invalid URL format' });
  }
});

// ----------------------------------------------------
// MEDIA UPLOAD
// ----------------------------------------------------
app.post('/api/upload', (req, res) => {
  const { dataUrl, filename } = req.body;
  if (!dataUrl) {
    return res.status(400).json({ error: 'No media data provided.' });
  }

  // In this environment, we return the base64 dataUrl directly as the media source
  res.json({
    url: dataUrl,
    filename: filename || 'uploaded_asset.jpg',
    size: Math.round(dataUrl.length * 0.75)
  });
});

// ----------------------------------------------------
// CONTACT FORM
// ----------------------------------------------------
app.post('/api/contact', (req, res) => {
  const { name, email, topic, subject, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }

  const db = DB.getInstance();
  const data = db.getData();

  const submission: ContactSubmission = {
    id: `cnt_${Date.now()}`,
    name,
    email,
    topic: topic || 'general',
    subject: subject || 'General Nexora Inquiry',
    message,
    createdAt: new Date().toISOString(),
    status: 'received'
  };

  data.contacts.unshift(submission);
  db.commit();

  res.status(201).json({ success: true, id: submission.id });
});

// ----------------------------------------------------
// ADMIN DASHBOARD API
// ----------------------------------------------------
app.get('/api/admin/stats', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const db = DB.getInstance();
  const data = db.getData();

  const totalUsers = data.users.length;
  const totalPosts = data.posts.length;
  const totalInteractions = data.posts.reduce((sum, p) => sum + p.likesCount + p.commentsCount + p.repostsCount, 0);
  const pendingReports = data.reports.filter(r => r.status === 'pending').length;
  const verifiedCreators = data.users.filter(u => u.isVerified).length;

  res.json({
    totalUsers,
    totalPosts,
    totalInteractions,
    pendingReports,
    activeToday: Math.round(totalUsers * 0.75),
    storageUsedMb: 142.8,
    verifiedCreators,
    recentActivity: [
      { id: '1', type: 'post', description: 'Elena Rostova published Monolith in Shadow', timestamp: '2h ago' },
      { id: '2', type: 'report', description: 'Julian Keller filed copyright inquiry on video test #4', timestamp: '5h ago' },
      { id: '3', type: 'user', description: 'Marcus Vance verified creator badge approved', timestamp: '1d ago' },
      { id: '4', type: 'system', description: 'Automated database snapshot completed (zero errors)', timestamp: '1d ago' }
    ]
  });
});

app.get('/api/admin/users', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  res.json(data.users);
});

app.put('/api/admin/users/:id/role', (req, res) => {
  const authUser = getAuthenticatedUser(req);
  if (!authUser || authUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const user = data.users.find(u => u.id === req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  user.role = req.body.role;
  db.commit();
  res.json(user);
});

app.put('/api/admin/users/:id/ban', (req, res) => {
  const authUser = getAuthenticatedUser(req);
  if (!authUser || authUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const user = data.users.find(u => u.id === req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  user.isBanned = !user.isBanned;
  db.commit();
  res.json({ isBanned: user.isBanned });
});

app.put('/api/admin/users/:id/verify', (req, res) => {
  const authUser = getAuthenticatedUser(req);
  if (!authUser || authUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  const user = data.users.find(u => u.id === req.params.id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  user.isVerified = !user.isVerified;
  db.commit();
  res.json({ isVerified: user.isVerified });
});

app.get('/api/admin/reports', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const db = DB.getInstance();
  const data = db.getData();
  res.json(data.reports);
});

app.post('/api/admin/reports/:id/resolve', (req, res) => {
  const user = getAuthenticatedUser(req);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }

  const { action } = req.body; // 'dismiss' | 'remove_post'
  const db = DB.getInstance();
  const data = db.getData();
  const report = data.reports.find(r => r.id === req.params.id);

  if (!report) {
    return res.status(404).json({ error: 'Report not found' });
  }

  report.status = action === 'dismiss' ? 'dismissed' : 'resolved';

  if (action === 'remove_post') {
    const postIdx = data.posts.findIndex(p => p.id === report.postId);
    if (postIdx > -1) {
      data.posts.splice(postIdx, 1);
    }
  }

  db.commit();
  res.json({ success: true, report });
});

// ----------------------------------------------------
// VITE INTEGRATION FOR FULL-STACK
// ----------------------------------------------------
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
        watch: process.env.DISABLE_HMR === 'true' ? null : {}
      },
      appType: 'spa'
    });

    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Nexora Full-Stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
