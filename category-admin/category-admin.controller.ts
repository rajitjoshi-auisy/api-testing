import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { CategoryAdminService } from './category-admin.service';
import { CategoryOperationDto } from './dto/category-admin.dto';
import { HttpJwtGuard } from '../../common/guards/http-jwt.guard';
import { StaffOnlyGuard } from '../../common/guards/staff-only.guard';

/**
 * Manages the issue categories customers pick from when raising a ticket.
 *
 * A single endpoint handles all four operations, selected by the `action` field
 * in the body. Every call therefore returns 200 — the action, not the HTTP
 * method, says what happened.
 *
 * Tickets are raised against a category only, so this module does not expose
 * the L2 level, which belongs to the chatbot's intent classification.
 *
 * Staff only. Note that `delete` deactivates rather than removes — tickets
 * store category codes as plain strings, so a real delete would orphan
 * historical tickets.
 */
@ApiTags('Category Admin')
@ApiBearerAuth()
@Controller('category-admin/categories')
@UseGuards(HttpJwtGuard, StaffOnlyGuard)
export class CategoryAdminController {
  constructor(private readonly categoryAdminService: CategoryAdminService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Category CRUD. Set action to list, create, update or delete.',
  })
  @ApiResponse({ status: 200, description: 'Operation completed' })
  @ApiResponse({ status: 400, description: 'Unknown action, or fields missing for that action' })
  @ApiResponse({ status: 403, description: 'Caller is not support staff' })
  @ApiResponse({ status: 404, description: 'Category not found (update, delete)' })
  @ApiResponse({ status: 409, description: 'A category with that code already exists (create)' })
  async execute(@Body() dto: CategoryOperationDto) {
    return this.categoryAdminService.execute(dto);
  }
}
