import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';

interface AuthenticatedRequest extends Request {
  user?: {
    id?: unknown;
  };
}

interface ErrorLogContext {
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  errorName: string;
  userId?: string;
  prismaCode?: string;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(caught: unknown, host: ArgumentsHost): void {
    const exception = this.toClientException(caught) ?? caught;
    const httpContext = host.switchToHttp();
    const response = httpContext.getResponse<Response>();
    const request = httpContext.getRequest<AuthenticatedRequest>();
    const timestamp = new Date().toISOString();
    const statusCode =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (statusCode >= Number(HttpStatus.INTERNAL_SERVER_ERROR)) {
      this.logServerError(exception, request, statusCode, timestamp);
    }

    if (response.headersSent) {
      response.end();
      return;
    }

    if (exception instanceof HttpException) {
      response
        .status(statusCode)
        .json(this.createHttpExceptionBody(exception, statusCode));
      return;
    }

    response.status(statusCode).json({
      statusCode,
      message: 'Ocurrió un error interno',
      path: this.getRequestPath(request),
      method: request.method,
      timestamp,
    });
  }

  // Express y body-parser marcan los errores del cliente con un status 4xx y
  // `expose: true` (convención de http-errors), p. ej. un body de más de 100 kb.
  // Nest solo traduce los SyntaxError, así que sin esto responderían 500.
  private toClientException(exception: unknown): HttpException | undefined {
    if (
      !(exception instanceof Error) ||
      !('expose' in exception) ||
      exception.expose !== true ||
      !('status' in exception) ||
      typeof exception.status !== 'number' ||
      exception.status < 400 ||
      exception.status > 499
    ) {
      return undefined;
    }

    const message =
      exception.status === Number(HttpStatus.PAYLOAD_TOO_LARGE)
        ? 'El cuerpo de la petición supera el tamaño máximo permitido'
        : exception.message;

    return new HttpException(
      HttpException.createBody(
        message,
        STATUS_CODES[exception.status] ?? 'Error',
        exception.status,
      ),
      exception.status,
    );
  }

  private createHttpExceptionBody(
    exception: HttpException,
    statusCode: number,
  ): object {
    const exceptionResponse = exception.getResponse();

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      return exceptionResponse;
    }

    return {
      statusCode,
      message: exceptionResponse,
    };
  }

  private logServerError(
    exception: unknown,
    request: AuthenticatedRequest,
    statusCode: number,
    timestamp: string,
  ): void {
    const context: ErrorLogContext = {
      timestamp,
      method: request.method,
      path: this.getLogPath(request),
      statusCode,
      errorName: this.getSafeErrorName(exception),
    };
    const userId = request.user?.id;
    const prismaCode = this.getPrismaErrorCode(exception);

    if (typeof userId === 'string') {
      context.userId = userId;
    }

    if (prismaCode) {
      context.prismaCode = prismaCode;
    }

    try {
      this.logger.error(JSON.stringify(context));
    } catch {
      // El logger nunca debe impedir que se envíe una respuesta segura.
    }
  }

  private getSafeErrorName(exception: unknown): string {
    if (!(exception instanceof Error)) {
      return 'UnknownException';
    }

    return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(exception.name)
      ? exception.name
      : 'UnknownException';
  }

  private getPrismaErrorCode(exception: unknown): string | undefined {
    if (typeof exception !== 'object' || exception === null) {
      return undefined;
    }

    if (!('code' in exception) || typeof exception.code !== 'string') {
      return undefined;
    }

    return /^P\d{4}$/.test(exception.code) ? exception.code : undefined;
  }

  private getLogPath(request: Request): string {
    const route = request.route as { path?: unknown } | undefined;

    if (typeof route?.path === 'string') {
      return `${request.baseUrl}${route.path}` || '/';
    }

    return this.getRequestPath(request);
  }

  private getRequestPath(request: Request): string {
    if (typeof request.path === 'string' && request.path.length > 0) {
      return request.path;
    }

    const url = request.originalUrl || request.url;
    return url.split('?', 1)[0] || '/';
  }
}
