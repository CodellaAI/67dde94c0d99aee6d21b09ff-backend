
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const User = require('../models/User');
const { isAuthenticated, optionalAuth } = require('../middleware/auth');

// Get all posts (with pagination)
router.get('/', optionalAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sortBy = req.query.sort || 'new'; // 'new', 'top', 'hot'
    const skip = (page - 1) * limit;
    
    let sortOption = {};
    
    switch (sortBy) {
      case 'top':
        sortOption = { voteCount: -1 };
        break;
      case 'hot':
        // A simple "hot" algorithm that combines recency and votes
        sortOption = { _id: -1 }; // Using _id as a proxy for time (MongoDB ObjectIds contain a timestamp)
        break;
      case 'new':
      default:
        sortOption = { createdAt: -1 };
    }
    
    const posts = await Post.find({ isDeleted: false })
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .populate('author', 'username avatar')
      .lean();
    
    // If user is authenticated, add their vote status to each post
    if (req.user) {
      for (let post of posts) {
        const userVote = post.votes.find(vote => 
          vote.user && vote.user.toString() === req.user._id.toString()
        );
        post.userVote = userVote ? userVote.value : 0;
      }
    }
    
    const total = await Post.countDocuments({ isDeleted: false });
    
    res.json({
      posts,
      totalPages: Math.ceil(total / limit),
      currentPage: page
    });
  } catch (error) {
    console.error('Get posts error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new post
router.post(
  '/',
  isAuthenticated,
  [
    body('title').trim().isLength({ min: 1, max: 300 }).withMessage('Title is required and cannot exceed 300 characters'),
    body('community').trim().not().isEmpty().withMessage('Community is required'),
    body('type').isIn(['text', 'image', 'link']).withMessage('Invalid post type'),
    body('content').optional().trim(),
    body('imageUrl').optional().isURL().withMessage('Image URL must be valid'),
    body('url').optional().isURL().withMessage('URL must be valid')
  ],
  async (req, res) => {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { title, content, type, imageUrl, url, community } = req.body;
      
      // Create new post
      const newPost = new Post({
        title,
        content: type === 'text' ? content : undefined,
        imageUrl: type === 'image' ? imageUrl : undefined,
        url: type === 'link' ? url : undefined,
        type,
        author: req.user._id,
        community
      });
      
      await newPost.save();
      
      // Populate author info before sending response
      await newPost.populate('author', 'username avatar');
      
      res.status(201).json(newPost);
    } catch (error) {
      console.error('Create post error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// Get a single post by ID
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const post = await Post.findOne({ _id: req.params.id, isDeleted: false })
      .populate('author', 'username avatar')
      .lean();
    
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    // If user is authenticated, add their vote status
    if (req.user) {
      const userVote = post.votes.find(vote => 
        vote.user && vote.user.toString() === req.user._id.toString()
      );
      post.userVote = userVote ? userVote.value : 0;
    }
    
    res.json(post);
  } catch (error) {
    console.error('Get post error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update a post
router.put(
  '/:id',
  isAuthenticated,
  [
    body('title').optional().trim().isLength({ min: 1, max: 300 }).withMessage('Title cannot exceed 300 characters'),
    body('content').optional().trim(),
    body('imageUrl').optional().isURL().withMessage('Image URL must be valid'),
    body('url').optional().isURL().withMessage('URL must be valid')
  ],
  async (req, res) => {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const post = await Post.findById(req.params.id);
      
      if (!post) {
        return res.status(404).json({ message: 'Post not found' });
      }
      
      // Check if user is the author
      if (post.author.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Not authorized to update this post' });
      }
      
      // Update fields based on post type
      const { title, content, imageUrl, url } = req.body;
      
      if (title) post.title = title;
      
      if (post.type === 'text' && content !== undefined) {
        post.content = content;
      } else if (post.type === 'image' && imageUrl) {
        post.imageUrl = imageUrl;
      } else if (post.type === 'link' && url) {
        post.url = url;
      }
      
      await post.save();
      
      // Populate author info before sending response
      await post.populate('author', 'username avatar');
      
      res.json(post);
    } catch (error) {
      console.error('Update post error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// Delete a post
router.delete('/:id', isAuthenticated, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    // Check if user is the author
    if (post.author.toString() !== req.user._id.toString() && !req.user.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this post' });
    }
    
    // Soft delete
    post.isDeleted = true;
    await post.save();
    
    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Delete post error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Vote on a post
router.post('/:id/vote', isAuthenticated, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    
    const { vote } = req.body;
    const voteValue = parseInt(vote);
    
    // Validate vote value
    if (![1, 0, -1].includes(voteValue)) {
      return res.status(400).json({ message: 'Invalid vote value' });
    }
    
    // Check if user has already voted
    const existingVoteIndex = post.votes.findIndex(
      v => v.user && v.user.toString() === req.user._id.toString()
    );
    
    if (existingVoteIndex !== -1) {
      if (voteValue === 0) {
        // Remove vote
        post.votes.splice(existingVoteIndex, 1);
      } else {
        // Update existing vote
        post.votes[existingVoteIndex].value = voteValue;
      }
    } else if (voteValue !== 0) {
      // Add new vote
      post.votes.push({
        user: req.user._id,
        value: voteValue
      });
    }
    
    // Recalculate vote count
    post.voteCount = post.calculateVoteCount();
    
    await post.save();
    
    // Update user karma
    const author = await User.findById(post.author);
    if (author) {
      author.karma = await calculateUserKarma(author._id);
      await author.save();
    }
    
    res.json({ 
      message: 'Vote recorded', 
      voteCount: post.voteCount,
      userVote: voteValue
    });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get posts by community
router.get('/community/:name', optionalAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const sortBy = req.query.sort || 'new';
    const skip = (page - 1) * limit;
    
    let sortOption = {};
    
    switch (sortBy) {
      case 'top':
        sortOption = { voteCount: -1 };
        break;
      case 'hot':
        sortOption = { _id: -1 };
        break;
      case 'new':
      default:
        sortOption = { createdAt: -1 };
    }
    
    const posts = await Post.find({ 
      community: req.params.name.toLowerCase(),
      isDeleted: false
    })
      .sort(sortOption)
      .skip(skip)
      .limit(limit)
      .populate('author', 'username avatar')
      .lean();
    
    // If user is authenticated, add their vote status to each post
    if (req.user) {
      for (let post of posts) {
        const userVote = post.votes.find(vote => 
          vote.user && vote.user.toString() === req.user._id.toString()
        );
        post.userVote = userVote ? userVote.value : 0;
      }
    }
    
    res.json(posts);
  } catch (error) {
    console.error('Get community posts error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get posts by user
router.get('/user/:username', optionalAuth, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const posts = await Post.find({ 
      author: user._id,
      isDeleted: false
    })
      .sort({ createdAt: -1 })
      .populate('author', 'username avatar')
      .lean();
    
    // If user is authenticated, add their vote status to each post
    if (req.user) {
      for (let post of posts) {
        const userVote = post.votes.find(vote => 
          vote.user && vote.user.toString() === req.user._id.toString()
        );
        post.userVote = userVote ? userVote.value : 0;
      }
    }
    
    res.json(posts);
  } catch (error) {
    console.error('Get user posts error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Search posts
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q) {
      return res.status(400).json({ message: 'Search query is required' });
    }
    
    const posts = await Post.find({
      $and: [
        { isDeleted: false },
        {
          $or: [
            { title: { $regex: q, $options: 'i' } },
            { content: { $regex: q, $options: 'i' } }
          ]
        }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .populate('author', 'username avatar')
      .lean();
    
    res.json(posts);
  } catch (error) {
    console.error('Search posts error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Helper function to calculate user karma
async function calculateUserKarma(userId) {
  try {
    // Sum up votes on user's posts
    const postVotes = await Post.aggregate([
      { $match: { author: userId, isDeleted: false } },
      { $unwind: '$votes' },
      { $group: { _id: null, total: { $sum: '$votes.value' } } }
    ]);
    
    // Sum up votes on user's comments
    const commentVotes = await Comment.aggregate([
      { $match: { author: userId, isDeleted: false } },
      { $unwind: '$votes' },
      { $group: { _id: null, total: { $sum: '$votes.value' } } }
    ]);
    
    const postKarma = postVotes.length > 0 ? postVotes[0].total : 0;
    const commentKarma = commentVotes.length > 0 ? commentVotes[0].total : 0;
    
    return postKarma + commentKarma;
  } catch (error) {
    console.error('Calculate karma error:', error);
    return 0;
  }
}

module.exports = router;
