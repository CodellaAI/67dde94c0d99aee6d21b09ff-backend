
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Comment = require('../models/Comment');
const Post = require('../models/Post');
const User = require('../models/User');
const { isAuthenticated, optionalAuth } = require('../middleware/auth');

// Get comments for a post
router.get('/post/:postId', optionalAuth, async (req, res) => {
  try {
    const comments = await Comment.find({ 
      post: req.params.postId,
      parentId: null, // Only get top-level comments
      isDeleted: false
    })
      .sort({ voteCount: -1, createdAt: -1 }) // Sort by votes then by date
      .populate('author', 'username avatar')
      .lean();
    
    // Get replies for each comment
    for (let comment of comments) {
      const replies = await getCommentReplies(comment._id, req.user?._id);
      comment.replies = replies;
      
      // If user is authenticated, add their vote status
      if (req.user) {
        const userVote = comment.votes.find(vote => 
          vote.user && vote.user.toString() === req.user._id.toString()
        );
        comment.userVote = userVote ? userVote.value : 0;
      }
    }
    
    res.json(comments);
  } catch (error) {
    console.error('Get comments error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Create a new comment
router.post(
  '/',
  isAuthenticated,
  [
    body('postId').not().isEmpty().withMessage('Post ID is required'),
    body('content').trim().isLength({ min: 1 }).withMessage('Comment content is required'),
    body('parentId').optional()
  ],
  async (req, res) => {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const { postId, content, parentId } = req.body;
      
      // Check if post exists
      const post = await Post.findById(postId);
      if (!post) {
        return res.status(404).json({ message: 'Post not found' });
      }
      
      // Check if parent comment exists if parentId is provided
      if (parentId) {
        const parentComment = await Comment.findById(parentId);
        if (!parentComment) {
          return res.status(404).json({ message: 'Parent comment not found' });
        }
      }
      
      // Create new comment
      const newComment = new Comment({
        content,
        author: req.user._id,
        post: postId,
        parentId: parentId || null
      });
      
      await newComment.save();
      
      // Increment comment count on post
      post.commentCount += 1;
      await post.save();
      
      // Populate author info before sending response
      await newComment.populate('author', 'username avatar');
      
      res.status(201).json(newComment);
    } catch (error) {
      console.error('Create comment error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// Update a comment
router.put(
  '/:id',
  isAuthenticated,
  [
    body('content').trim().isLength({ min: 1 }).withMessage('Comment content is required')
  ],
  async (req, res) => {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    
    try {
      const comment = await Comment.findById(req.params.id);
      
      if (!comment) {
        return res.status(404).json({ message: 'Comment not found' });
      }
      
      // Check if user is the author
      if (comment.author.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Not authorized to update this comment' });
      }
      
      // Update comment
      comment.content = req.body.content;
      comment.isEdited = true;
      
      await comment.save();
      
      // Populate author info before sending response
      await comment.populate('author', 'username avatar');
      
      res.json(comment);
    } catch (error) {
      console.error('Update comment error:', error);
      res.status(500).json({ message: 'Server error' });
    }
  }
);

// Delete a comment
router.delete('/:id', isAuthenticated, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.id);
    
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }
    
    // Check if user is the author or admin
    if (comment.author.toString() !== req.user._id.toString() && !req.user.isAdmin) {
      return res.status(403).json({ message: 'Not authorized to delete this comment' });
    }
    
    // Soft delete
    comment.isDeleted = true;
    comment.content = '[deleted]';
    await comment.save();
    
    res.json({ message: 'Comment deleted successfully' });
  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Vote on a comment
router.post('/:id/vote', isAuthenticated, async (req, res) => {
  try {
    const comment = await Comment.findById(req.params.id);
    
    if (!comment) {
      return res.status(404).json({ message: 'Comment not found' });
    }
    
    const { vote } = req.body;
    const voteValue = parseInt(vote);
    
    // Validate vote value
    if (![1, 0, -1].includes(voteValue)) {
      return res.status(400).json({ message: 'Invalid vote value' });
    }
    
    // Check if user has already voted
    const existingVoteIndex = comment.votes.findIndex(
      v => v.user && v.user.toString() === req.user._id.toString()
    );
    
    if (existingVoteIndex !== -1) {
      if (voteValue === 0) {
        // Remove vote
        comment.votes.splice(existingVoteIndex, 1);
      } else {
        // Update existing vote
        comment.votes[existingVoteIndex].value = voteValue;
      }
    } else if (voteValue !== 0) {
      // Add new vote
      comment.votes.push({
        user: req.user._id,
        value: voteValue
      });
    }
    
    // Recalculate vote count
    comment.voteCount = comment.calculateVoteCount();
    
    await comment.save();
    
    // Update user karma
    const author = await User.findById(comment.author);
    if (author) {
      author.karma = await calculateUserKarma(author._id);
      await author.save();
    }
    
    res.json({ 
      message: 'Vote recorded', 
      voteCount: comment.voteCount,
      userVote: voteValue
    });
  } catch (error) {
    console.error('Vote error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get comments by user
router.get('/user/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username });
    
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    
    const comments = await Comment.find({ 
      author: user._id,
      isDeleted: false
    })
      .sort({ createdAt: -1 })
      .populate('author', 'username avatar')
      .populate('post', 'title _id')
      .lean();
    
    res.json(comments);
  } catch (error) {
    console.error('Get user comments error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Helper function to recursively get comment replies
async function getCommentReplies(commentId, userId) {
  const replies = await Comment.find({ 
    parentId: commentId,
    isDeleted: false
  })
    .sort({ voteCount: -1, createdAt: -1 })
    .populate('author', 'username avatar')
    .lean();
  
  for (let reply of replies) {
    const nestedReplies = await getCommentReplies(reply._id, userId);
    reply.replies = nestedReplies;
    
    // Add user's vote status if user is authenticated
    if (userId) {
      const userVote = reply.votes.find(vote => 
        vote.user && vote.user.toString() === userId.toString()
      );
      reply.userVote = userVote ? userVote.value : 0;
    }
  }
  
  return replies;
}

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
